import assert from 'node:assert/strict'
import {
  appendProcessOutput,
  join,
  mkdir,
  reservePort,
  spawn,
  stopProcessGroup,
} from './shared.mjs'

export async function startRealObjectStorage(resultDir, timeoutMs) {
  // Pinned MinIO checks its default console port even with MINIO_BROWSER=off.
  const port = await reservePort(undefined, { excludedPorts: [13333] })
  const endpoint = `http://127.0.0.1:${port}`
  const dataDirectory = join(resultDir, 'minio-objects')
  await mkdir(dataDirectory, { recursive: true })
  const server = spawn(
    process.env.WEWORK_E2E_MINIO_BIN?.trim() || 'minio',
    ['server', dataDirectory, '--address', `127.0.0.1:${port}`],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MINIO_ROOT_USER: 'desktop-e2e-access-key',
        MINIO_ROOT_PASSWORD: 'desktop-e2e-secret-key',
        MINIO_BROWSER: 'off',
      },
    }
  )
  let spawnError
  server.once('error', error => {
    spawnError = error
  })
  await Promise.all([
    appendProcessOutput(server.stdout, join(resultDir, 'minio.log')),
    appendProcessOutput(server.stderr, join(resultDir, 'minio.log')),
  ])
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      assert.equal(server.exitCode, null, 'Real MinIO exited before becoming ready')
      try {
        if ((await fetch(`${endpoint}/minio/health/ready`)).ok)
          return {
            backendEnv: {
              ATTACHMENT_S3_ENDPOINT: endpoint,
              ATTACHMENT_S3_ACCESS_KEY: 'desktop-e2e-access-key',
              ATTACHMENT_S3_SECRET_KEY: 'desktop-e2e-secret-key',
              ATTACHMENT_S3_USE_SSL: 'false',
              ATTACHMENT_S3_REGION: 'us-east-1',
            },
            stop: () => stopProcessGroup(server),
          }
      } catch {
        // The real MinIO process has not bound its listening socket yet.
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('Real MinIO did not become ready')
  } catch (error) {
    await stopProcessGroup(server)
    throw error
  }
}
