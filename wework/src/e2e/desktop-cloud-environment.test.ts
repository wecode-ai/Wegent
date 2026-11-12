// @vitest-environment node

import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { RealCloudEnvironment } from '../../e2e/desktop/modules/cloud-environment.mjs'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

test('remote executor owns its logs and Homes independently of the desktop host', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'wework-cloud-restart-'))
  const environment = new RealCloudEnvironment({}) as unknown as CloudEnvironment
  environment.backend = null
  environment.backendEnv = { TERMINAL_PROTOCOL_V2_ENABLED: 'true' }
  environment.backendLogPath = join(directory, 'backend.log')
  environment.remoteExecutorLogPath = join(directory, 'executor.log')
  const registration =
    'local backend registered backend_url=http://127.0.0.1:8000 device_id=wework-e2e-cloud-device\n'
  await writeFile(environment.remoteExecutorLogPath, registration)
  const launchBackend = vi.fn(async () => {
    await appendFile(
      environment.remoteExecutorLogPath,
      'local backend registered backend_url=http://127.0.0.1:8000 device_id=wework-e2e-cloud-device-other\n'
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
    await appendFile(environment.remoteExecutorLogPath, registration)
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

test('authorization readiness requires a successful poll for the exact new session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-cloud-authorization-'))
  const cloud = new RealCloudEnvironment({})
  cloud.backendApiLogPath = join(directory, 'api.log')
  const id = '12345678-1234-1234-1234-123456789abc'
  const pending = `[API] GET /api/auth/wework/sessions/${id}/poll?poll_token=fixture-poll`
  await writeFile(cloud.backendApiLogPath, `${pending} 500 0ms 200 0\n`)
  const settled = vi.fn()
  const readOffset = vi.mocked(readFile).mock.results.length
  const ready = cloud.waitForAuthorizationPolling(id).then(settled)
  try {
    await appendFile(
      cloud.backendApiLogPath,
      '[API] GET /api/auth/wework/sessions/other-session/poll?poll_token=fixture-other 200 0ms\n'
    )
    await vi.waitFor(async () => {
      const observed = await Promise.all(
        vi
          .mocked(readFile)
          .mock.results.slice(readOffset)
          .map(result => result.value)
      )
      expect(
        observed.some(
          value => String(value).includes('other-session') && String(value).includes('500 0ms')
        )
      ).toBe(true)
    })
    const prematurelyReady = await Promise.race([
      ready.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
    ])
    expect(prematurelyReady).toBe(false)
  } finally {
    await appendFile(cloud.backendApiLogPath, `${pending} 200 0ms\n`)
    try {
      await ready
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  expect(settled).toHaveBeenCalledOnce()
})
