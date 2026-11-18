import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { RealCloudEnvironment } from '../desktop/modules/cloud-environment.mjs'
import { resultDir, weworkDir, stopProcessGroup } from '../desktop/modules/shared.mjs'

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
  await cloud.startBackend()
  if (!stopping) {
    vite = spawn(
      process.execPath,
      [
        join(weworkDir, 'node_modules/vite/bin/vite.js'),
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
}
