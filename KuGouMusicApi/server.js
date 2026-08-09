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

  // TRIM_API_TOKEN 获取（双重保障：环境变量 + 文件）
  // 1) 优先使用 docker-entrypoint.sh export 的环境变量
  // 2) 如果环境变量为空，直接读 /app/.trim_token 文件
  let TRIM_API_TOKEN = process.env.TRIM_API_TOKEN || '';
  const TOKEN_FILE_PATH = '/app/.trim_token';
  if (!TRIM_API_TOKEN && fs.existsSync(TOKEN_FILE_PATH)) {
    try {
      const fileToken = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
      if (fileToken) {
        TRIM_API_TOKEN = fileToken;
        console.log('[FNOS] 从文件读取 TRIM_API_TOKEN 成功 (长度=' + fileToken.length + ')');
      }
    } catch (e) {
      console.warn('[FNOS] 读取 token 文件失败:', e.message);
    }
  }

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
  console.log('  TOKEN_FILE_PATH       :', TOKEN_FILE_PATH, 'exists:', fs.existsSync(TOKEN_FILE_PATH) ? 'YES' : 'NO');
  console.log('========================================');

  // 飞牛路由统一挂到 Router 上，然后同时暴露 /fnos/* 和 /api/fnos/* 两个前缀
  // 本地开发靠 Vite proxy 把 /api/fnos/* 转成后端 /fnos/*；
  // 飞牛容器内前端直接请求 /api/fnos/*，需要后端原生支持
  const fnosRouter = express.Router();

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
  // 鉴权说明（官方文档）：
  //   - 当应用在 config/resource 声明了对应 scope（如 trim.file.sharedAccess），
  //     飞牛后端会通过 Unix Socket + appName 自动识别应用身份，
  //     不需要 Authorization: Bearer token 头。
  //   - 我们仍然带上 TRIM_API_TOKEN 作为额外安全层（如果有的话）。
  //   - 关键：**无论 token 是否为空都必须发请求**，不能因为 token 空就跳过。
  const fnosOpenApi = (req, data) => {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        reqId: String(Date.now() + Math.random()),
        req,
        appName: TRIM_APPNAME,
        data: data || {},
      });

      // 构建 headers：始终带 Content-Type，可选带 Authorization
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };
      if (TRIM_API_TOKEN) {
        headers['Authorization'] = `Bearer ${TRIM_API_TOKEN}`;
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
            // 请求成功（无论 code 是 0 还是其他），都 resolve 让上层处理
            resolve(parsed);
          } catch (e) {
            // 不是 JSON（通常是错误响应），直接 reject
            reject(new Error('非JSON响应: ' + buf.slice(0, 200)));
          }
        });
      });

      hReq.on('error', (err) => {
        // socket 连接错误 → 这是真正的失败
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

  // 查询管理员为应用授权的共享目录列表（严格按飞牛"访问权限"的勾选结果）
  //
  // 数据源优先级（严格，绝不扫描子目录瞎猜）：
  //   1) trim.file.getSharedAccessibleFolders  → 飞牛后台精确返回用户在"访问权限"里勾选的目录
  //      文档: https://developer.fnnas.com/api/authorization/shared-access/#查询共享授权路径
  //      这是唯一可信来源。如果调用失败，说明 TRIM_API_TOKEN 或 socket 有问题。
  //   2) 应用自身的 data-share 目录（/var/apps/KGconcept/shares/KGconcept 下的直接子目录）
  //      → 这是 config/resource 的 shares 声明里应用自带的共享目录
  //      飞牛会自动把它们挂到容器，用户在"访问权限"面板里也能看到
  fnosRouter.get('/shared-folders', async (req, res) => {
    const folders = [];
    const seenPaths = new Set();
    const addFolder = (p, source, label) => {
      if (!p || seenPaths.has(p)) return;
      seenPaths.add(p);
      folders.push({ path: p, source, label: label || p });
    };

    // (1) 应用自身共享目录（config/resource 声明的 shares）
    //     固定先加默认下载 DOWNLOAD_DIR（即 KGconcept/downloads）
    if (DOWNLOAD_DIR) {
      addFolder(DOWNLOAD_DIR, 'data-share', '默认下载目录 (应用共享)');
    }
    // 父级 KGconcept 目录（DOWNLOAD_DIR/../）也可能被声明为 share
    try {
      const appShareRoot = DOWNLOAD_DIR
        ? path.resolve(DOWNLOAD_DIR, '..')
        : '/var/apps/KGconcept/shares/KGconcept';
      if (fs.existsSync(appShareRoot) && isPathWritable(appShareRoot) && appShareRoot !== DOWNLOAD_DIR) {
        addFolder(appShareRoot, 'app-share', '应用文件/KGconcept');
      }
    } catch (_) {}

    if (!FNOS_ENV) {
      return res.json({ code: 0, msg: '', data: { paths: folders } });
    }

    // (2) 调用飞牛官方后端 API：trim.file.getSharedAccessibleFolders
    //     严格使用这个结果 — 用户在"访问权限"里勾选了哪几个，这里就返回哪几个，
    //     不做任何文件系统扫描，不猜任何子目录。
    let rawPaths = [];
    try {
      console.log('[FNOS] 调用 trim.file.getSharedAccessibleFolders（严格查询访问权限目录）...');
      const apiResp = await fnosOpenApi('trim.file.getSharedAccessibleFolders');
      console.log('[FNOS] getSharedAccessibleFolders 返回:', JSON.stringify(apiResp));

      if (apiResp?.code === 0 && Array.isArray(apiResp?.data?.paths)) {
        rawPaths = apiResp.data.paths;
      } else {
        console.warn('[FNOS] getSharedAccessibleFolders 返回 code=%s msg=%s', apiResp?.code, apiResp?.msg);
        // 返回结构不符合预期，继续往下走（有 data-share 的目录保底）
      }
    } catch (e) {
      console.warn('[FNOS] getSharedAccessibleFolders 调用失败:', e.message);
      console.warn('[FNOS] 请检查: TRIM_API_TOKEN 长度=', TRIM_API_TOKEN.length, ' Socket 存在=', fs.existsSync(FNOS_SOCKET_PATH));
    }

    // (3) 把 rawPaths 里的路径转成友好显示名称
    let pathMap = {};
    if (rawPaths.length > 0) {
      try {
        const convertResp = await fnosOpenApi('trim.file.convertPath', {
          path: rawPaths,
          language: 'zh-CN',
        });
        if (convertResp?.code === 0 && Array.isArray(convertResp?.data?.result)) {
          for (const item of convertResp.data.result) {
            pathMap[item.path] = item.semanticPath || item.path;
          }
        }
      } catch (e) {
        console.warn('[FNOS] convertPath 失败，用原始路径作为 label:', e.message);
      }
    }
    for (const p of rawPaths) {
      addFolder(p, 'app-authorization', pathMap[p] || p);
    }

    console.log('[FNOS] 本次刷新返回目录列表（严格来自 data-share + getSharedAccessibleFolders）:');
    for (const f of folders) {
      console.log(`  - [${f.source}] ${f.label}  →  ${f.path}`);
    }
    res.json({ code: 0, msg: '', data: { paths: folders } });
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
