import type StaticServer from '@dr.pogodin/react-native-static-server'
import { randomUUID } from 'expo-crypto'
import { Platform } from 'react-native'

import type { LoadedMobileFile } from '@/types/files'

const ASSET_FOLDER = 'wework-preview'
let fs: typeof import('@dr.pogodin/react-native-fs')
let Server: typeof StaticServer
let cacheRoot: string
let assetPreparation: Promise<string> | undefined
let operation: Promise<unknown> = Promise.resolve()
let active: { nonce: string; release: () => Promise<void> } | undefined

interface AssetManifest {
  version: string
  files: { path: string; size: number }[]
}

export interface MobilePreviewSession {
  url: string
  fileUrl: string
  nonce: string
  bridgeToken: string
  addResource: (resource: { uri: string; name: string }) => Promise<string>
  release: () => Promise<void>
}

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = operation.then(action, action)
  operation = result
  return result
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('File preview was cancelled')
}

async function loadNativeRuntime(): Promise<void> {
  if (fs && Server) return
  const [filesystem, server] = await Promise.all([
    import('@dr.pogodin/react-native-fs'),
    import('@dr.pogodin/react-native-static-server'),
  ])
  fs = filesystem
  Server = server.default
  cacheRoot = `${fs.CachesDirectoryPath}/wework-preview`
}

async function prepareAssets(): Promise<string> {
  const sessions = `${cacheRoot}/sessions`
  if (await fs.exists(sessions)) await fs.unlink(sessions)
  const raw =
    Platform.OS === 'ios'
      ? await fs.readFile(`${fs.MainBundlePath}/${ASSET_FOLDER}/preview-assets.json`, 'utf8')
      : await fs.readFileAssets(`${ASSET_FOLDER}/preview-assets.json`)
  const manifest = parseAssetManifest(raw)
  if (Platform.OS === 'ios') {
    const directory = `${fs.MainBundlePath}/${ASSET_FOLDER}`
    await validateAssets(directory, manifest)
    return directory
  }
  const directory = `${cacheRoot}/assets-${manifest.version}`
  if (!(await fs.exists(`${directory}/.ready`))) {
    await fs.mkdir(directory)
    await fs.copyFileAssets(ASSET_FOLDER, directory)
  }
  try {
    await validateAssets(directory, manifest)
  } catch (error) {
    if (await fs.exists(`${directory}/.ready`)) await fs.unlink(`${directory}/.ready`)
    throw error
  }
  await fs.writeFile(`${directory}/.ready`, manifest.version, 'utf8')
  for (const entry of await fs.readDir(cacheRoot)) {
    if (entry.isDirectory() && /^assets-[a-f0-9]{64}$/.test(entry.name) && entry.path !== directory)
      await fs.unlink(entry.path)
  }
  return directory
}

function parseAssetManifest(raw: string): AssetManifest {
  let manifest: AssetManifest
  try {
    manifest = JSON.parse(raw) as AssetManifest
  } catch (cause) {
    throw new Error('文件预览资源清单无效，请重新构建应用', { cause })
  }
  if (
    !manifest ||
    !/^[a-f0-9]{64}$/.test(manifest.version) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    !manifest.files.every(
      file =>
        file &&
        typeof file.path === 'string' &&
        !file.path.includes('\\') &&
        file.path.split('/').every(part => part && part !== '.' && part !== '..') &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0
    ) ||
    !manifest.files.some(file => file.path === 'index.html') ||
    new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
  )
    throw new Error('文件预览资源清单无效，请重新构建应用')
  return manifest
}

async function validateAssets(directory: string, manifest: AssetManifest): Promise<void> {
  for (let offset = 0; offset < manifest.files.length; offset += 64) {
    await Promise.all(
      manifest.files.slice(offset, offset + 64).map(async file => {
        const path = `${directory}/${file.path}`
        if (!(await fs.exists(path)))
          throw new Error(`文件预览资源缺失 (${file.path})，请重新构建应用`)
        const stat = await fs.stat(path)
        if (!stat.isFile() || stat.size !== file.size)
          throw new Error(`文件预览资源损坏 (${file.path})，请重新构建应用`)
      })
    )
  }
}

function getAssets(): Promise<string> {
  if (!assetPreparation) {
    assetPreparation = prepareAssets().catch(error => {
      assetPreparation = undefined
      throw error
    })
  }
  return assetPreparation
}

function quoteConfig(value: string): string {
  return JSON.stringify(value)
}

function safeFilename(name: string): string {
  const filename = name.replace(/[\\/\u0000-\u001f]/g, '_')
  return !filename || filename === '.' || filename === '..' ? 'document' : filename
}

function localPath(uri: string): string {
  return uri.startsWith('file:') ? decodeURIComponent(new URL(uri).pathname) : uri
}

function serverConfig(assets: string, nonce: string): string {
  const aliases = ['assets', 'vendor', 'wasm'].map(
    name => `${quoteConfig(`/${nonce}/${name}/`)} => ${quoteConfig(`${assets}/${name}/`)}`
  )
  return [
    'server.modules += ("mod_alias", "mod_setenv")',
    `alias.url = (${aliases.join(', ')})`,
    'dir-listing.activate = "disable"',
    'server.follow-symlink = "disable"',
    'mimetype.assign = (".html" => "text/html", ".js" => "text/javascript", ".mjs" => "text/javascript", ".css" => "text/css", ".wasm" => "application/wasm", ".json" => "application/json", ".svg" => "image/svg+xml", ".png" => "image/png", ".jpg" => "image/jpeg", ".jpeg" => "image/jpeg", ".gif" => "image/gif", ".webp" => "image/webp", ".avif" => "image/avif", ".mp4" => "video/mp4", ".webm" => "video/webm", ".ogv" => "video/ogg", ".mp3" => "audio/mpeg", ".wav" => "audio/wav", ".ogg" => "audio/ogg", ".woff" => "font/woff", ".woff2" => "font/woff2", ".ttf" => "font/ttf", ".otf" => "font/otf", "" => "application/octet-stream")',
    'setenv.add-response-header = ("Referrer-Policy" => "no-referrer", "X-Content-Type-Options" => "nosniff")',
    `$HTTP["url"] =~ ${quoteConfig(`^/${nonce}/(document|resources)/`)} {`,
    '  setenv.add-response-header += ("Content-Security-Policy" => "sandbox")',
    '}',
  ].join('\n')
}

/** Serves only bundled renderers and one selected cached file, never the app's cache root. */
export function openMobilePreview(
  document: LoadedMobileFile,
  signal?: AbortSignal
): Promise<MobilePreviewSession> {
  return serialize(async () => {
    checkAborted(signal)
    await loadNativeRuntime()
    checkAborted(signal)
    if (active) await active.release()
    const assets = await getAssets()
    checkAborted(signal)
    const nonce = randomUUID()
    const bridgeToken = randomUUID()
    const root = `${cacheRoot}/sessions/${nonce}`
    const directory = `${root}/${nonce}`
    const filename = safeFilename(document.name)
    const filePath = `${directory}/document/${filename}`
    let server: StaticServer | undefined
    let released = false
    let closing = false
    const release = async () => {
      if (released) return
      closing = true
      const failures: unknown[] = []
      try {
        if (server) await server.stop()
      } catch (error) {
        failures.push(error)
      }
      try {
        if (await fs.exists(root)) await fs.unlink(root)
      } catch (error) {
        failures.push(error)
      }
      if (failures.length) throw new AggregateError(failures, '文件预览资源清理失败')
      released = true
      if (active?.nonce === nonce) active = undefined
    }
    try {
      await fs.mkdir(`${directory}/document`)
      const index = await fs.readFile(`${assets}/index.html`, 'utf8')
      if (!index.includes('<head>')) throw new Error('文件预览入口无效，请重新构建应用')
      const bootstrap = `<script>if(window===window.top){window.__WEWORK_PREVIEW_TOKEN__=${JSON.stringify(bridgeToken)}}</script>`
      await fs.writeFile(
        `${directory}/index.html`,
        index.replace('<head>', `<head>${bootstrap}`),
        'utf8'
      )
      if (document.uri) {
        await fs.copyFile(localPath(document.uri), filePath)
      } else if (document.text !== undefined) {
        await fs.writeFile(filePath, document.text, 'utf8')
      } else throw new Error('文件内容尚未下载')
      checkAborted(signal)
      server = new Server({
        fileDir: root,
        hostname: '127.0.0.1',
        port: 0,
        errorLog: false,
        stopInBackground: false,
        extraConfig: serverConfig(assets, nonce),
      })
      active = { nonce, release }
      const origin = await server.start()
      checkAborted(signal)
      const session = {
        url: `${origin}/${nonce}/index.html#${nonce}`,
        fileUrl: `${origin}/${nonce}/document/${encodeURIComponent(filename)}`,
        nonce,
        bridgeToken,
        addResource: (resource: { uri: string; name: string }) =>
          serialize(async () => {
            if (released || closing) throw new Error('文件预览已关闭')
            const name = safeFilename(resource.name)
            const relative = `resources/${randomUUID()}/${name}`
            await fs.mkdir(`${directory}/${relative.slice(0, relative.lastIndexOf('/'))}`)
            await fs.copyFile(localPath(resource.uri), `${directory}/${relative}`)
            return `${origin}/${nonce}/${relative.split('/').map(encodeURIComponent).join('/')}`
          }),
        release,
      }
      active = session
      return { ...session, release: () => serialize(release) }
    } catch (error) {
      try {
        await release()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '文件预览启动和资源清理失败')
      }
      throw error
    }
  })
}
