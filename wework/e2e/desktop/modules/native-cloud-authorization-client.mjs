import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export async function nativeCloudAuthorization(
  cloudEnvironment,
  userDataDirectory,
  snapshotId,
  clear = false,
  appBinary = process.env.WEWORK_E2E_APP_BIN
) {
  assert.ok(appBinary, 'Native cloud authorization requires the shared packaged application')
  const startedAt = Date.now()
  await new Promise((resolve, reject) => {
    const child = execFile(
      appBinary,
      [fileURLToPath(new URL('./native-cloud-authorization.mjs', import.meta.url))],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[desktop-e2e-native-cloud-authorization]', {
            phase: clear ? 'restore' : 'authorize',
            code: error.code ?? null,
            signal: error.signal ?? null,
            killed: error.killed === true,
            elapsedMs: Date.now() - startedAt,
            stdoutBytes: Buffer.byteLength(stdout ?? ''),
            stderrBytes: Buffer.byteLength(stderr ?? ''),
          })
          reject(error)
        } else if (stdout !== (clear ? 'cleared' : 'authorized'))
          reject(new Error('Native cloud authorization did not complete'))
        else resolve()
      }
    )
    child.stdin.end(
      JSON.stringify({
        apiBaseUrl: `${cloudEnvironment.backendUrl}/api`,
        authToken: cloudEnvironment.authToken,
        userDataDirectory,
        snapshotId,
        clear,
      })
    )
  })
}

/** Register cleanup before authorization so a partially claimed session is restored too. */
export function nativeCloudAuthorizationFixture(cloud, userDataDirectory, appBinary) {
  const id = randomUUID()
  return {
    authorize: () => nativeCloudAuthorization(cloud, userDataDirectory, id, false, appBinary),
    restore: () => nativeCloudAuthorization(cloud, userDataDirectory, id, true, appBinary),
  }
}
