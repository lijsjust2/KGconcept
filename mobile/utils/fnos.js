import { get, post } from './request'

const log = (...args) => {
  console.log('[fnos]', ...args)
}

let fnosStatus = null
let statusChecked = false
let checkingPromise = null

const FOLDER_KEY = 'KGconcept_downloadFolder'

/**
 * 检测当前是否运行在飞牛 fnOS 环境下
 * 首次调用会请求后端 /fnos/status，后续返回缓存结果
 * @returns {Promise<{isFnos: boolean, downloadDir: string, enabled: boolean, defaultDownloadDir: string}>}
 */
export async function checkFnosEnv() {
  if (statusChecked) return fnosStatus
  if (checkingPromise) return checkingPromise

  checkingPromise = (async () => {
    try {
      const res = await get('/fnos/status', {}, { timeout: 5000 })
      fnosStatus = {
        isFnos: !!res?.isFnos,
        downloadDir: res?.downloadDir || '',
        enabled: !!res?.enabled,
        defaultDownloadDir: res?.defaultDownloadDir || res?.downloadDir || '',
      }
      log('飞牛环境检测结果:', fnosStatus)
    } catch (e) {
      log('飞牛环境检测失败，视为非飞牛环境:', e?.message)
      fnosStatus = { isFnos: false, downloadDir: '', enabled: false, defaultDownloadDir: '' }
    }
    statusChecked = true
    checkingPromise = null
    return fnosStatus
  })()

  return checkingPromise
}

/**
 * 同步获取已缓存的飞牛环境状态
 */
export function getFnosStatus() {
  return fnosStatus || { isFnos: false, downloadDir: '', enabled: false, defaultDownloadDir: '' }
}

/**
 * 查询管理员为应用授权的全部下载目录（应用共享 + 手动授权目录）
 * @returns {Promise<{path: string, source: string, label: string}[]>}
 */
export async function getSharedFolders() {
  try {
    await checkFnosEnv()
    const res = await get('/fnos/shared-folders', {}, { timeout: 8000 })
    if (res?.code === 0 && Array.isArray(res?.data?.paths)) {
      return res.data.paths
    }
    log('获取下载目录列表失败:', res?.msg)
    return []
  } catch (e) {
    log('获取下载目录列表异常:', e?.message)
    return []
  }
}

/** 获取用户选择的下载目录（localStorage 持久化） */
export function getSavedDownloadFolder() {
  try {
    return localStorage.getItem(FOLDER_KEY) || ''
  } catch (_) {
    return ''
  }
}

/** 保存用户选择的下载目录 */
export function saveDownloadFolder(path) {
  try {
    if (path) localStorage.setItem(FOLDER_KEY, path)
    else localStorage.removeItem(FOLDER_KEY)
    log('下载目录已保存:', path || '(默认)')
  } catch (_) {}
}

/**
 * 在飞牛环境下，通过后端下载文件到共享目录
 * @param {string} url 音频文件下载URL
 * @param {string} fileName 保存的文件名
 * @param {string} artist 歌手名（仅 categorize=true 时使用）
 * @param {string} album 专辑名（仅 categorize=true 时使用）
 * @param {boolean} [categorize=false] 是否按「歌手/专辑」分类存储
 * @param {string} [targetPath] 目标下载根目录；留空使用用户保存的或默认
 * @returns {Promise<{success: boolean, path?: string, msg?: string}>}
 */
export async function downloadToFnos(url, fileName, artist, album, categorize = false, targetPath) {
  try {
    const savePath = targetPath || getSavedDownloadFolder() || undefined
    const res = await post(
      '/fnos/download',
      { url, fileName, artist, album, categorize, targetPath: savePath },
      { timeout: 120000 }
    )
    if (res?.code === 0) {
      log('飞牛下载成功:', res.data?.rootDir, res.data?.path)
      return { success: true, path: res.data?.path, rootDir: res.data?.rootDir }
    }
    return { success: false, msg: res?.msg || '下载失败' }
  } catch (e) {
    log('飞牛下载请求失败:', e?.message)
    return { success: false, msg: e?.message || '下载请求失败' }
  }
}
