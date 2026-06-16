import { beforeEach, describe, expect, test, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getLocalExecutorStatus: vi.fn(),
  runLocalExecutorAction: vi.fn(),
}))

vi.mock('@wecode/api/local-executor', () => apiMocks)

describe('local executor startup check', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  test('automatically starts a stopped executor only once', async () => {
    apiMocks.getLocalExecutorStatus
      .mockResolvedValueOnce({
        node: {
          available: true,
          version: 'v22.12.0',
          meets_minimum: true,
          path: '/opt/homebrew/bin/node',
          major_version: 22,
          error: null,
        },
        cli: {
          available: true,
          version: '3.0.28',
          path: '/Users/alice/.wecode/wecode-cli/bin/wecode',
          error: null,
        },
        installed: true,
        running: false,
        pid: null,
        version: null,
        output: '',
        error: null,
      })
      .mockResolvedValueOnce({
        node: {
          available: true,
          version: 'v22.12.0',
          meets_minimum: true,
          path: '/opt/homebrew/bin/node',
          major_version: 22,
          error: null,
        },
        cli: {
          available: true,
          version: '3.0.28',
          path: '/Users/alice/.wecode/wecode-cli/bin/wecode',
          error: null,
        },
        installed: true,
        running: true,
        pid: 12345,
        version: null,
        output: '',
        error: null,
      })
    apiMocks.runLocalExecutorAction.mockResolvedValue({
      success: true,
      code: 0,
      stdout: 'started',
      stderr: '',
    })

    const startup = await import('./local-executor-startup')
    const firstRun = startup.startLocalExecutorStartupCheck()
    const secondRun = startup.startLocalExecutorStartupCheck()

    expect(firstRun).toBe(secondRun)
    await firstRun
    expect(apiMocks.runLocalExecutorAction).toHaveBeenCalledTimes(1)
    expect(startup.getLocalExecutorStartupSnapshot()).toMatchObject({
      tone: 'success',
      label: '本机环境已就绪',
      progress: 100,
    })
  })

  test('installs a missing CLI and executor before starting', async () => {
    const status = (cliAvailable: boolean, installed: boolean, running: boolean) => ({
      node: {
        available: true,
        version: 'v22.12.0',
        meets_minimum: true,
        path: '/opt/homebrew/bin/node',
        major_version: 22,
        error: null,
      },
      cli: {
        available: cliAvailable,
        version: cliAvailable ? '3.0.28' : null,
        path: cliAvailable ? '/Users/alice/.wecode/wecode-cli/bin/wecode' : null,
        error: cliAvailable ? null : 'wecode not found',
      },
      installed,
      running,
      pid: running ? 12345 : null,
      version: null,
      output: '',
      error: null,
    })
    apiMocks.getLocalExecutorStatus
      .mockResolvedValueOnce(status(false, false, false))
      .mockResolvedValueOnce(status(true, false, false))
      .mockResolvedValueOnce(status(true, true, false))
      .mockResolvedValueOnce(status(true, true, true))
    apiMocks.runLocalExecutorAction.mockResolvedValue({
      success: true,
      code: 0,
      stdout: 'ok',
      stderr: '',
    })

    const startup = await import('./local-executor-startup')
    await startup.startLocalExecutorStartupCheck()

    expect(apiMocks.runLocalExecutorAction.mock.calls.map(([action]) => action)).toEqual([
      'install-cli',
      'install',
      'start',
    ])
    expect(startup.getLocalExecutorStartupSnapshot()).toMatchObject({
      tone: 'success',
      label: '本机环境已就绪',
      progress: 100,
    })
    expect(startup.getLocalExecutorStartupSnapshot().steps.map(step => step.title)).toEqual([
      '检测 Node.js',
      '检测 WeCode CLI',
      '自动安装 WeCode CLI',
      '检测 Executor 状态',
      '自动安装 Executor',
      '自动启动 Executor',
    ])
  })
})
