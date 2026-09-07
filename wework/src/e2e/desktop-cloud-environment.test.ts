import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'

interface CloudEnvironment {
  backend: null
  backendEnv: Record<string, string>
  backendLogPath: string
  remoteExecutorLogPath: string
  launchBackend: () => Promise<void>
  waitForDevice: (deviceId: string, logPath: string) => Promise<void>
  restartBackendWithTerminalProtocolV2: (enabled: boolean) => Promise<void>
}

test('backend restart requires fresh registration before accepting cached online status', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/modules/cloud-environment.mjs')
  ).href
  const { RealCloudEnvironment } = (await import(/* @vite-ignore */ moduleUrl)) as {
    RealCloudEnvironment: new (options: Record<string, unknown>) => CloudEnvironment
  }
  const directory = await mkdtemp(join(tmpdir(), 'wework-cloud-restart-'))
  const environment = new RealCloudEnvironment({})
  environment.backend = null
  environment.backendEnv = { TERMINAL_PROTOCOL_V2_ENABLED: 'true' }
  environment.backendLogPath = join(directory, 'backend.log')
  environment.remoteExecutorLogPath = join(directory, 'executor.log')
  const registration = '[Device WS] Device registered: user=1, device=wework-e2e-cloud-device\n'
  await writeFile(environment.backendLogPath, registration)
  const launchBackend = vi.fn(async () => {
    await appendFile(
      environment.backendLogPath,
      '[Device WS] Device registered: user=1, device=wework-e2e-cloud-device-other\n'
    )
  })
  const waitForDevice = vi.fn(async () => {})
  environment.launchBackend = launchBackend
  environment.waitForDevice = waitForDevice

  const restart = environment.restartBackendWithTerminalProtocolV2(false)
  try {
    await vi.waitFor(() => expect(launchBackend).toHaveResolved())
    expect(waitForDevice).not.toHaveBeenCalled()
    expect(environment.backendEnv.TERMINAL_PROTOCOL_V2_ENABLED).toBe('false')
  } finally {
    await appendFile(environment.backendLogPath, registration)
    try {
      await restart
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  expect(waitForDevice).toHaveBeenCalledExactlyOnceWith(
    'wework-e2e-cloud-device',
    environment.remoteExecutorLogPath
  )
})
