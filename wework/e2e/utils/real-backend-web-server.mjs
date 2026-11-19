import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RealCloudEnvironment } from '../desktop/modules/cloud-environment.mjs'
import { resultDir, runChecked, weworkDir, stopProcessGroup } from '../desktop/modules/shared.mjs'

const webRoot = await mkdtemp(join(tmpdir(), 'wework-browser-web-'))
const viteBinary = join(weworkDir, 'node_modules/vite/bin/vite.js')
await mkdir(resultDir, { recursive: true })
const cloud = new RealCloudEnvironment({
  modelServerUrl: process.env.WEWORK_RESPONSE_API_MOCK_URL,
})
let stopping = false
let finish
const stopped = new Promise(resolve => {
  finish = resolve
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stopping = true
    finish()
  })
let vite
try {
  const archive = process.env.WEWORK_E2E_PREBUILT_WEB_ARCHIVE?.trim()
  if (archive) {
    await runChecked('tar', [
      '-xzf',
      archive,
      '-C',
      webRoot,
      '--strip-components=3',
      './wework-app/web',
    ])
  } else {
    await runChecked(
      process.execPath,
      [viteBinary, 'build', '--mode', 'e2e', '--base', '/wework/app/', '--outDir', webRoot],
      { cwd: weworkDir, env: process.env }
    )
  }
  await cloud.startBackend()
  await writeFile(
    join(webRoot, 'runtime-config.js'),
    'window.__WEWORK_RUNTIME_CONFIG__ = ' +
      JSON.stringify({
        appBasePath: '/wework/app/',
        desktopHost: 'browser',
        runtimeMode: 'backend',
        loginMode: 'password',
        wegentBackendUrl: cloud.backendUrl,
        apiBaseUrl: cloud.backendUrl + '/api',
        socketBaseUrl: cloud.socketUrl,
        socketPath: '/socket.io',
      }) +
      '\n'
  )
  if (!stopping) {
    vite = spawn(
      process.execPath,
      [
        viteBinary,
        'preview',
        '--outDir',
        webRoot,
        '--base',
        '/wework/app/',
        '--strictPort',
        '--host',
        '127.0.0.1',
        '--port',
        process.env.WEWORK_E2E_PORT ?? '4174',
        '--mode',
        'e2e',
      ],
      {
        cwd: weworkDir,
        detached: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          VITE_WEGENT_BACKEND_URL: cloud.backendUrl,
          VITE_WEGENT_SOCKET_URL: cloud.socketUrl,
        },
      }
    )
    await Promise.race([
      stopped,
      new Promise((resolve, reject) => {
        vite.once('error', reject)
        vite.once('exit', (code, signal) => {
          if (code === 0 && !signal) resolve()
          else reject(new Error(`Vite exited: code=${code} signal=${signal}`))
        })
      }),
    ])
  }
} finally {
  await stopProcessGroup(vite)
  await cloud.stop()
  await rm(webRoot, { recursive: true, force: true })
}
