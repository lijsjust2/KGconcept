const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const decode = require('safe-decode-uri-component');
const { cookieToJson, randomString, getGuid, calculateMid } = require('./util/util');
const { cryptoMd5 } = require('./util/crypto');
const { createRequest } = require('./util/request');
const axios = require('axios');
const dotenv = require('dotenv');
const cache = require('./util/apicache').middleware;

/**
 * @typedef {{
 * identifier?: string,
 * route: string,
 * module: any,
 * }}ModuleDefinition
 */

/**
 * @typedef {{
 *  server?: import('http').Server,
 * }} ExpressExtension
 */

const guid = cryptoMd5(getGuid());
const serverDev = randomString(10).toUpperCase();

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

/**
 *  描述：动态获取模块定义
 * @param {string}  modulesPath  模块路径(TS)
 * @param {Record<string, string>} specificRoute  特定模块定义
 * @param {boolean} doRequire  如果为 true，则使用 require 加载模块, 否则打印模块路径， 默认为true
 * @return { Promise<ModuleDefinition[]> }
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(modulesPath, specificRoute, doRequire = true) {
  const files = await fs.promises.readdir(modulesPath);
  const parseRoute = (fileName) =>
    specificRoute && fileName in specificRoute ? specificRoute[fileName] : `/${fileName.replace(/\.(js)$/i, '').replace(/_/g, '/')}`;

  return files
    .reverse()
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('_'))
    .map((fileName) => {
      const identifier = fileName.split('.').shift();
      const route = parseRoute(fileName);
      const modulePath = path.resolve(modulesPath, fileName);
      const module = doRequire ? require(modulePath) : modulePath;
      return { identifier, route, module };
    });
}

/**
 * 创建服务
 * @param {ModuleDefinition[]} moduleDefs
 * @return {Promise<import('express').Express>}
 */
async function consturctServer(moduleDefs) {
  const app = express();
  const { CORS_ALLOW_ORIGIN } = process.env;
  app.set('trust proxy', true);

  /**
   * CORS & Preflight request
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'Authorization,X-Requested-With,Content-Type,Cache-Control',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  // Cookie Parser
  app.use((req, _, next) => {
    req.cookies = {};
    (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const crack = pair.indexOf('=');
      if (crack < 1 || crack === pair.length - 1) {
        return;
      }
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(pair.slice(crack + 1)).trim();
    });
    next();
  });

  // 将当前平台写入Cookie 以方便查看
  app.use((req, res, next) => {
    const cookies = req.cookies || {};
    const isHttps = req.protocol === 'https';
    const cookieSuffix = isHttps ? '; PATH=/; SameSite=None; Secure' : '; PATH=/';

    const ensureCookie = (key, value) => {
      if (Object.prototype.hasOwnProperty.call(cookies, key)) return;
      cookies[key] = String(value);
      res.append('Set-Cookie', `${key}=${cookies[key]}${cookieSuffix}`);
    };

    const mid = calculateMid(process.env.KUGOU_API_GUID ?? guid);
    ensureCookie('KUGOU_API_PLATFORM', process.env.platform);
    ensureCookie('KUGOU_API_MID', mid);
    ensureCookie('KUGOU_API_GUID', process.env.KUGOU_API_GUID ?? guid);
    ensureCookie('KUGOU_API_DEV', (process.env.KUGOU_API_DEV ?? serverDev).toUpperCase());
    ensureCookie('KUGOU_API_MAC', (process.env.KUGOU_API_MAC ?? '02:00:00:00:00:00').toUpperCase());

    req.cookies = cookies;

    next();
  });

  // Body Parser
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  /**
   * Serving static files
   */
  app.use(express.static(path.join(__dirname, 'public')));

  /**
   * docs
   */

  app.use('/docs', express.static(path.join(__dirname, 'docs')));

  // ==================== 飞牛 fnOS 环境接口 ====================
  const FNOS_ENV = process.env.FNOS_ENV === 'true';
  const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '';
  const TRIM_APPNAME = process.env.TRIM_APPNAME || 'KGconcept';
  const FNOS_SOCKET_PATH = process.env.FNOS_SOCKET_PATH || '/var/run/trim_open_gateway_apiscope.socket';
  const http = require('http');

  // TRIM_API_TOKEN 获取（三重保障 + 文件变更实时刷新）
  // 文档: https://developer.fnnas.com/api/calling/#接口调用认证
  //   - 飞牛调用 cmd/* / install_callback / config_callback 脚本时，会把当前可用 token 注入
  //     TRIM_API_TOKEN 环境变量，并注入 TRIM_APPDEST（应用安装目录）。
  //   - 我们在这些脚本里，把 token 写入 ${TRIM_APPDEST}/.trim_token（默认 /var/apps/KGconcept/.trim_token）。
  //   - docker-compose 挂载整个 /var/apps/KGconcept 目录（只读）进容器，避免单文件挂载时
  //     docker 误创建空目录占位的致命 bug。
  // 策略:
  //   1) 启动时优先读 process.env.TRIM_API_TOKEN
  //   2) 读 TRIM_TOKEN_FILE（env 可配置，默认 /var/apps/KGconcept/.trim_token）
  //   3) 每 5 秒 + 每次 fnos 请求进入时，检查 token 文件 mtime/内容变化，有更新立刻重载
  let TRIM_API_TOKEN = process.env.TRIM_API_TOKEN || '';
  let TOKEN_FILE_LAST_MTIME = 0;
  let TOKEN_FILE_LAST_LEN = -1;
  let TOKEN_FILE_LAST_ERR = null;
  let TOKEN_FILE_LAST_STAT = null; // 'file' | 'dir' | 'missing' | 'other'
  const TOKEN_FILE_PATH =
    process.env.TRIM_TOKEN_FILE ||
    '/var/apps/KGconcept/.trim_token';  // 与 fnap/cmd/* 和 docker-compose 保持一致

  const refreshTokenFromFile = (forceLog = false) => {
    if (!fs.existsSync(TOKEN_FILE_PATH)) {
      TOKEN_FILE_LAST_STAT = 'missing';
      TOKEN_FILE_LAST_ERR = `文件不存在: ${TOKEN_FILE_PATH}`;
      if (forceLog) console.warn('[FNOS] TOKEN_FILE 不存在:', TOKEN_FILE_PATH);
      return false;
    }
    try {
      const stat = fs.statSync(TOKEN_FILE_PATH);
      // 关键：区分文件 vs 目录（docker 单文件挂载时，如果宿主机文件不存在，docker 会创建空目录）
      if (stat.isDirectory()) {
        TOKEN_FILE_LAST_STAT = 'dir';
        TOKEN_FILE_LAST_ERR = `${TOKEN_FILE_PATH} 是目录（docker 误创建的空目录，不是真实 token 文件）`;
        if (forceLog) console.error('[FNOS] FATAL: TOKEN_FILE 是目录，不是文件！', TOKEN_FILE_PATH);
        return false;
      }
      if (!stat.isFile()) {
        TOKEN_FILE_LAST_STAT = 'other';
        TOKEN_FILE_LAST_ERR = `${TOKEN_FILE_PATH} 不是普通文件（${stat.mode}）`;
        return false;
      }
      TOKEN_FILE_LAST_STAT = 'file';
      TOKEN_FILE_LAST_ERR = null;

      const fileContent = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
      const changed =
        stat.mtimeMs !== TOKEN_FILE_LAST_MTIME ||
        fileContent.length !== TOKEN_FILE_LAST_LEN ||
        fileContent !== TRIM_API_TOKEN;
      if (changed) {
        if (fileContent) {
          TRIM_API_TOKEN = fileContent;
          console.log(
            '[FNOS] TRIM_API_TOKEN 已从文件刷新 (长度=' +
              fileContent.length +
              ', mtime=' +
              new Date(stat.mtimeMs).toISOString() +
              ', path=' + TOKEN_FILE_PATH + ')'
          );
        } else if (forceLog) {
          console.warn('[FNOS] TOKEN_FILE 存在但内容为空 (0 字节)');
        }
        TOKEN_FILE_LAST_MTIME = stat.mtimeMs;
        TOKEN_FILE_LAST_LEN = fileContent.length;
        return fileContent ? true : false;
      }
    } catch (e) {
      TOKEN_FILE_LAST_ERR = `${e.code || 'ERR'}: ${e.message}`;
      console.warn('[FNOS] 读取 token 文件失败:', e.code, e.message);
    }
    return false;
  };

  // 启动时立即尝试一次（强制打日志）
  refreshTokenFromFile(true);

  // 后台轮询：每 5 秒检查一次 token 文件变更
  // 关键：用户改「访问权限」后，飞牛会执行 config_callback → 写新 token 文件
  // 这里监听到文件变更就立刻重载，这样用户点「刷新」按钮时拿到的就是新 token 调的 API
  setInterval(() => {
    refreshTokenFromFile(false);
  }, 5000);

  // 启动时诊断：打印飞牛环境配置
  console.log('========================================');
  console.log('[FNOS] 启动环境诊断');
  console.log('  FNOS_ENV              :', FNOS_ENV);
  console.log('  DOWNLOAD_DIR          :', DOWNLOAD_DIR);
  console.log('  TRIM_APPNAME          :', TRIM_APPNAME);
  console.log('  TRIM_API_TOKEN        :', TRIM_API_TOKEN ? `OK (length=${TRIM_API_TOKEN.length})` : 'EMPTY — 后端 API 调用会失败');
  console.log('  FNOS_SOCKET_PATH      :', FNOS_SOCKET_PATH);
  console.log('  Socket exists?        :', fs.existsSync(FNOS_SOCKET_PATH) ? 'YES' : 'NO');
  console.log('  DOWNLOAD_DIR exists?  :', fs.existsSync(DOWNLOAD_DIR) ? 'YES' : 'NO');
  console.log('  TOKEN_FILE_PATH       :', TOKEN_FILE_PATH);
  console.log('  TOKEN_FILE stat       :', TOKEN_FILE_LAST_STAT, TOKEN_FILE_LAST_ERR ? `(ERR: ${TOKEN_FILE_LAST_ERR})` : '');
  console.log('  TOKEN_FILE length     :', TOKEN_FILE_LAST_LEN < 0 ? '(未读取)' : `${TOKEN_FILE_LAST_LEN} bytes`);
  console.log('========================================');

  // 飞牛路由统一挂到 Router 上，然后同时暴露 /fnos/* 和 /api/fnos/* 两个前缀
  // 本地开发靠 Vite proxy 把 /api/fnos/* 转成后端 /fnos/*；
  // 飞牛容器内前端直接请求 /api/fnos/*，需要后端原生支持
  const fnosRouter = express.Router();

  // fnos 路由专用中间件：
  //   1) 禁用任何缓存（浏览器/代理/apicache 全禁），保证「刷新」按钮一定拿到最新结果
  //   2) 每次请求都立刻 refreshTokenFromFile，用户改完「访问权限」→ config_callback 写新 token 后，
  //      下次点刷新立刻用上新 token，不用等 5 秒轮询，也不用重启容器
  fnosRouter.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const changed = refreshTokenFromFile(false);
    if (changed) {
      console.log('[FNOS] ' + req.path + ' 请求触发 token 文件刷新，已加载最新 token');
    }
    next();
  });

  // 辅助：检查路径是否可写
  const isPathWritable = (p) => {
    try {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch (_) {
      return false;
    }
  };

  // 通过飞牛 OpenAPI Unix Socket 调用后端能力
  //
  // 严格按飞牛官方文档:
  //   - Unix Socket: /var/run/trim_open_gateway_apiscope.socket
  //   - URL: POST /api/v1/trimapp
  //   - 必须带: Authorization: Bearer <token>
  //   - 请求体: { reqId, req, appName, data }
  //   - token 从 process.env.TRIM_API_TOKEN 读取，或从 /app/.trim_token 文件读取
  const fnosOpenApi = (req, data) => {
    return new Promise((resolve, reject) => {
      // 每次调用前刷新 token（确保读到最新的 token 文件）
      refreshTokenFromFile();

      const payload = JSON.stringify({
        reqId: String(Date.now() + Math.random()),
        req,
        appName: TRIM_APPNAME,
        data: data || {},
      });

      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };

      // 严格按文档：必须带 Authorization: Bearer <token>
      if (TRIM_API_TOKEN) {
        headers['Authorization'] = `Bearer ${TRIM_API_TOKEN}`;
      } else {
        // token 为空也发请求，让飞牛后端返回明确的错误信息
        // 这样我们就能知道是 token 问题还是其他问题
        console.warn('[FNOS] fnosOpenApi 调用时 TRIM_API_TOKEN 为空:', req);
      }

      const options = {
        socketPath: FNOS_SOCKET_PATH,
        path: '/api/v1/trimapp',
        method: 'POST',
        headers,
        timeout: 8000,
      };

      const hReq = http.request(options, (hRes) => {
        let buf = '';
        hRes.setEncoding('utf8');
        hRes.on('data', (c) => (buf += c));
        hRes.on('end', () => {
          try {
            const parsed = JSON.parse(buf);
            resolve(parsed);
          } catch (e) {
            reject(new Error('非JSON响应: ' + buf.slice(0, 200)));
          }
        });
      });

      hReq.on('error', (err) => {
        reject(new Error(`Unix Socket 连接失败 (${FNOS_SOCKET_PATH}): ${err.message}`));
      });
      hReq.on('timeout', () => {
        hReq.destroy();
        reject(new Error('请求超时 (8s)'));
      });
      hReq.write(payload);
      hReq.end();
    });
  };

  // 判断某个绝对路径是否位于 DOWNLOAD_DIR（共享目录）或已挂载的 /vol1 下
  const isAllowedDownloadRoot = (abs) => {
    const roots = [];
    if (DOWNLOAD_DIR) roots.push(path.resolve(DOWNLOAD_DIR));
    roots.push('/vol1');
    const target = path.resolve(abs);
    return roots.some((r) => {
      const rp = path.resolve(r);
      return target === rp || target.startsWith(rp.endsWith(path.sep) ? rp : rp + path.sep);
    });
  };

  // 飞牛环境状态查询
  fnosRouter.get('/status', (req, res) => {
    res.json({
      isFnos: FNOS_ENV,
      downloadDir: DOWNLOAD_DIR,
      enabled: FNOS_ENV && !!DOWNLOAD_DIR,
      defaultDownloadDir: DOWNLOAD_DIR,
    });
  });

  // 诊断：把当前环境信息压缩到 /fnos/shared-folders 响应里，便于用户直接在前端看到问题
  const buildEnvSnapshot = () => ({
    socketExists: fs.existsSync(FNOS_SOCKET_PATH),
    socketPath: FNOS_SOCKET_PATH,
    trimAppName: TRIM_APPNAME,
    tokenLength: TRIM_API_TOKEN.length,
    tokenPresent: !!TRIM_API_TOKEN,
    fnosEnv: FNOS_ENV,
    downloadDir: DOWNLOAD_DIR,
    tokenFileExists: fs.existsSync(TOKEN_FILE_PATH),
    tokenFilePath: TOKEN_FILE_PATH,
    tokenFileStat: TOKEN_FILE_LAST_STAT,
    tokenFileError: TOKEN_FILE_LAST_ERR,
    tokenFileLen: TOKEN_FILE_LAST_LEN,
  });

  // 查询管理员为应用授权的共享目录列表
  // 核心原则：严格按飞牛「访问权限」勾选结果，即 trim.file.getSharedAccessibleFolders 返回的内容
  // 绝不自己扫描 /vol1 或其他目录。只额外保留应用自身 data-share 的默认下载目录。
  // 文档:
  //   https://developer.fnnas.com/api/authorization/shared-access/
  //   trim.file.getSharedAccessibleFolders → 返回应用可访问的用户授权目录列表
  //   trim.file.convertPath → 把绝对路径转成用户友好的语义路径（如"存储空间1/xxx"）
  fnosRouter.get('/shared-folders', async (req, res) => {
    const folders = [];
    const seenPaths = new Set();
    const addFolder = (p, source, label) => {
      if (!p || seenPaths.has(p)) return;
      seenPaths.add(p);
      folders.push({ path: p, source, label: label || p });
    };

    // (1) 应用自身 data-share 共享目录（config/resource 声明的 shares）
    //     这个是应用默认的下载目录，始终保留。
    if (DOWNLOAD_DIR) {
      addFolder(DOWNLOAD_DIR, 'data-share', '默认下载目录 (应用共享)');
    }

    let debug = { ...buildEnvSnapshot(), openApiCall: null, convertCall: null, tokenUsedHead: null };

    // 每次调用前先主动刷新一次 token（不等轮询），确保最新的 token 立刻生效
    refreshTokenFromFile(true);
    debug.tokenUsedHead = TRIM_API_TOKEN ? TRIM_API_TOKEN.slice(0, 12) + '...' : '(empty)';
    debug.tokenFileMtime = TOKEN_FILE_LAST_MTIME ? new Date(TOKEN_FILE_LAST_MTIME).toISOString() : null;

    if (!FNOS_ENV) {
      console.log('[FNOS] 非 FNOS_ENV 环境，跳过 OpenAPI 调用，仅返回 data-share 目录');
      return res.json({ code: 0, msg: '', data: { paths: folders }, _debug: debug });
    }

    // (2) 调用飞牛官方 API：trim.file.getSharedAccessibleFolders
    //     严格按文档：req 名字 + Authorization: Bearer <token>
    //     这个接口返回的才是用户在「访问权限」里真正勾选的目录！
    let rawPaths = [];
    try {
      console.log('[FNOS] >>> 调用 trim.file.getSharedAccessibleFolders');
      console.log('[FNOS]     本次使用 token 前缀:', debug.tokenUsedHead, '长度:', TRIM_API_TOKEN.length);
      const apiResp = await fnosOpenApi('trim.file.getSharedAccessibleFolders');
      debug.openApiCall = { success: true, response: apiResp };
      console.log('[FNOS] <<< getSharedAccessibleFolders 完整返回:', JSON.stringify(apiResp));

      // 兼容各种可能的返回格式（文档说 data.paths，也可能 data 直接是数组或其他结构）
      if (apiResp?.code === 0) {
        if (Array.isArray(apiResp?.data?.paths)) {
          rawPaths = apiResp.data.paths;
        } else if (Array.isArray(apiResp?.data)) {
          rawPaths = apiResp.data;
        } else if (Array.isArray(apiResp?.paths)) {
          rawPaths = apiResp.paths;
        }
        // 如果返回的是 [{path:..., name:...}, ...] 对象数组，提取 path
        if (rawPaths.length > 0 && typeof rawPaths[0] === 'object' && rawPaths[0].path) {
          rawPaths = rawPaths.map((x) => x.path);
        }
        console.log('[FNOS]     → 解析后 rawPaths 共', rawPaths.length, '条:', JSON.stringify(rawPaths));
      } else {
        console.warn(
          '[FNOS]     ! OpenAPI 返回非正常 code=',
          apiResp?.code,
          'msg=',
          apiResp?.msg,
          '完整 response=',
          JSON.stringify(apiResp)
        );
      }
    } catch (e) {
      debug.openApiCall = { success: false, error: e.message, stack: e.stack?.split('\n').slice(0, 3).join('\n') };
      console.warn('[FNOS] getSharedAccessibleFolders 调用异常:', e.message);
    }

    // (3) 调用 trim.file.convertPath 把绝对路径转换成语义路径（友好显示名）
    //     传参严格按文档：{ path: string[] | string, language: 'zh-CN' }
    let pathMap = {};
    if (rawPaths.length > 0) {
      try {
        const convertResp = await fnosOpenApi('trim.file.convertPath', {
          path: rawPaths,
          language: 'zh-CN',
        });
        debug.convertCall = { success: true, response: convertResp };
        console.log('[FNOS] <<< convertPath 完整返回:', JSON.stringify(convertResp));

        if (convertResp?.code === 0) {
          let arr = [];
          if (Array.isArray(convertResp?.data?.result)) arr = convertResp.data.result;
          else if (Array.isArray(convertResp?.data)) arr = convertResp.data;
          else if (Array.isArray(convertResp?.result)) arr = convertResp.result;

          for (const item of arr) {
            // 兼容 { path, semanticPath } 和 { path, name } 和 其他可能
            const p = item.path || item.absolutePath || '';
            const label = item.semanticPath || item.name || item.displayName || item.label || p;
            if (p) pathMap[p] = label;
          }
          console.log('[FNOS]     → 解析后 pathMap:', JSON.stringify(pathMap));
        } else {
          console.warn(
            '[FNOS]     ! convertPath 返回非正常 code=',
            convertResp?.code,
            'msg=',
            convertResp?.msg
          );
        }
      } catch (e) {
        debug.convertCall = { success: false, error: e.message };
        console.warn('[FNOS] convertPath 调用异常:', e.message);
      }
    }

    // (4) 把 OpenAPI 拿到的授权目录加入最终列表（source=app-authorization，严格按"访问权限"定义）
    for (const p of rawPaths) {
      addFolder(p, 'app-authorization', pathMap[p] || p);
    }

    console.log('[FNOS] 最终 shared-folders 返回 (共' + folders.length + '条):');
    for (const f of folders) {
      console.log(`  - [${f.source}] ${f.label}  ->  ${f.path}`);
    }

    res.json({ code: 0, msg: '', data: { paths: folders }, _debug: debug });
  });

  // 诊断端点：返回飞牛环境配置和 socket/token 状态，便于排查
  fnosRouter.get('/debug', async (req, res) => {
    const debug = {
      FNOS_ENV,
      DOWNLOAD_DIR,
      TRIM_APPNAME,
      TRIM_API_TOKEN: TRIM_API_TOKEN ? `${TRIM_API_TOKEN.slice(0, 8)}...(${TRIM_API_TOKEN.length} chars)` : '(empty)',
      FNOS_SOCKET_PATH,
      socketExists: fs.existsSync(FNOS_SOCKET_PATH),
      openApiTest: null,
    };

    // 尝试调用 getSharedAccessibleFolders 并返回完整结果
    if (FNOS_ENV) {
      try {
        const apiResp = await fnosOpenApi('trim.file.getSharedAccessibleFolders');
        debug.openApiTest = { success: true, response: apiResp };
      } catch (e) {
        debug.openApiTest = { success: false, error: e.message };
      }
    }

    res.json(debug);
  });

  // 仅在飞牛环境下启用服务端下载到共享目录
  if (FNOS_ENV && DOWNLOAD_DIR) {
    const sanitize = (name) => String(name || '未知')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    // 下载文件到共享目录
    fnosRouter.post('/download', async (req, res) => {
      const logDownload = (msg) => {
        const ts = new Date().toISOString();
        const line = `[${ts}] ${msg}\n`;
        fs.promises.appendFile(path.join(DOWNLOAD_DIR, '.download.log'), line).catch(() => {});
      };

      try {
        const { url, fileName, artist, album, categorize, targetPath } = req.body || {};
        if (!url || !fileName) {
          return res.status(400).json({ code: 1, msg: '缺少 url 或 fileName 参数' });
        }
        const safeFileName = sanitize(fileName);

        // 确定根目录：优先使用用户选择的 targetPath（必须在允许范围），否则回退 DOWNLOAD_DIR
        let rootDir = DOWNLOAD_DIR;
        if (targetPath && typeof targetPath === 'string' && targetPath.trim()) {
          if (isAllowedDownloadRoot(targetPath)) {
            rootDir = targetPath;
          } else {
            logDownload(`WARN: targetPath ${targetPath} 不在允许范围，回退到默认 DOWNLOAD_DIR`);
          }
        }

        // 诊断：确认根目录可写
        try {
          await fs.promises.access(rootDir, fs.constants.W_OK);
        } catch (e) {
          try {
            await fs.promises.chmod(rootDir, 0o777);
            await fs.promises.access(rootDir, fs.constants.W_OK);
          } catch (_) {
            logDownload(`ERROR: rootDir ${rootDir} 不可写，挂载/授权可能未生效`);
          }
        }

        // 仅批量下载（/download/ 页面，categorize=true）按 歌手/专辑 分类；
        // 单曲及其他列表下载直接放到根目录，不再分类
        let dir = rootDir;
        if (categorize) {
          const safeArtist = sanitize(artist || '未知歌手');
          const safeAlbum = sanitize(album || '未知专辑');
          dir = path.join(rootDir, safeArtist, safeAlbum);
        }
        await fs.promises.mkdir(dir, { recursive: true });

        const filePath = path.join(dir, safeFileName);
        const response = await axios.get(url, { responseType: 'stream', timeout: 60000, maxRedirects: 5 });

        const writer = fs.createWriteStream(filePath);
        let writeError = null;
        writer.on('error', (err) => {
          writeError = err;
          logDownload(`ERROR: createWriteStream失败 ${filePath}: ${err.message}`);
        });
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on('finish', () => {
            if (writeError) reject(writeError);
            else resolve();
          });
          writer.on('error', reject);
          response.data.on('error', reject);
        });

        const absPath = filePath;
        const relativePath = path.relative(rootDir, filePath) || safeFileName;
        let fileSize = -1;
        try { fileSize = (await fs.promises.stat(absPath)).size; } catch (__) {}
        logDownload(`SUCCESS: root=${rootDir} 绝对路径=${absPath} 相对路径=${relativePath} 大小=${fileSize}B`);
        console.log('[FNOS] 文件已保存:', absPath, relativePath, `${fileSize}B`);
        res.json({ code: 0, msg: '下载成功', data: { path: relativePath, absPath: absPath, size: fileSize, rootDir } });
      } catch (e) {
        console.error('[FNOS] 下载失败:', e.message);
        logDownload(`ERROR: 下载异常: ${e.message}`);
        res.status(500).json({ code: 1, msg: '下载失败: ' + e.message });
      }
    });

    // 列出已下载的音频文件
    fnosRouter.get('/downloads', async (req, res) => {
      try {
        const results = [];
        const scanDir = async (dir, depth = 0) => {
          if (depth > 3) return;
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await scanDir(fullPath, depth + 1);
            } else if (/\.(mp3|flac)$/i.test(entry.name)) {
              const rel = path.relative(DOWNLOAD_DIR, fullPath);
              const stat = await fs.promises.stat(fullPath);
              results.push({ path: rel, name: entry.name, size: stat.size });
            }
          }
        };
        await scanDir(DOWNLOAD_DIR);
        res.json({ code: 0, data: { files: results } });
      } catch (e) {
        res.status(500).json({ code: 1, msg: '读取列表失败: ' + e.message });
      }
    });
  }

  // 同时挂载到 /fnos 和 /api/fnos，兼容本地开发与飞牛容器两种环境
  app.use('/fnos', fnosRouter);
  app.use('/api/fnos', fnosRouter);

  // Cache
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200));

  const moduleDefinitions = moduleDefs || (await getModulesDefinitions(path.join(__dirname, 'module'), {}));

  for (const moduleDef of moduleDefinitions) {
    app.use(moduleDef.route, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie));
        }
      });

      const { cookie, ...params } = req.query;

      const query = Object.assign({}, { cookie: Object.assign({}, req.cookies, cookie) }, params, { body: req.body });

      const authHeader = req.headers['authorization'];
      if (authHeader) {
        query.cookie = {
          ...query.cookie,
          ...cookieToJson(authHeader),
        };
      }
      try {
        const moduleResponse = await moduleDef.module(query, (config) => {
          let ip = req.ip;
          if (ip.substring(0, 7) === '::ffff:') {
            ip = ip.substring(7);
          }
          config.ip = ip;
          return createRequest(config);
        });

        console.log('[OK]', decode(req.originalUrl));

        const cookies = moduleResponse.cookie;
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              // Try to fix CORS SameSite Problem
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return `${cookie}; PATH=/; SameSite=None; Secure`;
                })
              );
            } else {
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return `${cookie}; PATH=/`;
                })
              );
            }
          }
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      } catch (e) {
        const moduleResponse = e;
        console.log('[ERR]', decode(req.originalUrl), {
          status: moduleResponse.status,
          body: moduleResponse.body,
        });

        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          });
          return;
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      }
    });
  }

  return app;
}

/**
 * Serve the KG API
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function startService() {
  const port = Number(process.env.PORT || '3000');
  const host = process.env.HOST || '';

  const app = await consturctServer();

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app;

  appExt.service = app.listen(port, host, () => {
    console.log(`server running @ http://${host || 'localhost'}:${port}`);
  });

  return appExt;
}

module.exports = { startService, getModulesDefinitions };
