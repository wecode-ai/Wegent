import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'

test('remote executor owns its logs and Homes independently of the desktop host', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/modules/cloud-environment.mjs')
  ).href
  const { RealCloudEnvironment } = await import(/* @vite-ignore */ moduleUrl)
  const inheritedHomes = [
    'WEGENT_WORKBENCH_HOME',
    'WEGENT_CAPABILITIES_HOME',
    'WEGENT_CLAUDE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    'CODEX_SQLITE_HOME',
    'WEWORK_E2E_NATIVE_CODEX_HOME',
  ]
  vi.stubEnv('WEGENT_EXECUTOR_DISABLE_FILE_LOG', 'true')
  for (const key of [...inheritedHomes, 'HOME', 'USERPROFILE', 'WEGENT_CODEX_HOME']) {
    vi.stubEnv(key, '/synthetic-desktop-home')
  }
  try {
    const cloud = new RealCloudEnvironment({
      workspacePath: '/synthetic-remote/workspace',
      codexBinary: '/synthetic-remote/codex',
      claudeBinary: '/synthetic-remote/claude',
    })
    for (const deviceType of ['cloud', 'remote']) {
      const home = `/synthetic-${deviceType}`
      const environment = cloud.executorEnv({
        deviceId: `${deviceType}-device`,
        deviceName: deviceType,
        deviceType,
        home,
        codexHome: `${home}/codex`,
        logFile: `${deviceType}-runtime.log`,
      })
      expect(environment.WEGENT_EXECUTOR_DISABLE_FILE_LOG).toBe('false')
      expect(environment.WEGENT_EXECUTOR_LOG_FILE).toBe(`${deviceType}-runtime.log`)
      expect(environment.WEGENT_EXECUTOR_LOG_DIR).toBeTruthy()
      expect(environment.HOME).toBe(home)
      expect(environment.USERPROFILE).toBe(home)
      expect(environment.WEGENT_EXECUTOR_HOME).toBe(home)
      expect(environment.CODEX_HOME).toBe(`${home}/codex`)
      expect(environment.WEGENT_CODEX_HOME).toBe(`${home}/codex`)
      expect(environment.CLAUDE_BINARY_PATH).toBe('/synthetic-remote/claude')
      for (const key of inheritedHomes) expect(environment).not.toHaveProperty(key)
    }
    expect(process.env.WEGENT_EXECUTOR_DISABLE_FILE_LOG).toBe('true')
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('/synthetic-desktop-home')
  } finally {
    vi.unstubAllEnvs()
  }
})

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

test('a completed cloud turn remains an active conversation and must settle the task wait', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/modules/cloud-environment.mjs')
  ).href
  const { RealCloudEnvironment } = await import(/* @vite-ignore */ moduleUrl)
  const environment = new RealCloudEnvironment({})
  const address = { taskId: 'cloud-task', workspacePath: '/workspace' }
  environment.runtimeTask = vi
    .fn()
    .mockResolvedValueOnce({ ...address, running: false, status: 'queued' })
    .mockResolvedValueOnce({ ...address, running: true, status: 'running' })
    .mockResolvedValue({ ...address, running: false, status: 'active', threadStatus: 'idle' })
  const result = await environment.waitForRuntimeTask(address)
  expect(result).toMatchObject({ ...address, running: false, status: 'active' })
  expect(environment.runtimeTask).toHaveBeenCalledTimes(3)
  environment.runtimeTask.mockResolvedValue({ ...address, running: false, status: 'failed' })
  await expect(environment.waitForRuntimeTask(address)).rejects.toThrow('settled as failed')
})
