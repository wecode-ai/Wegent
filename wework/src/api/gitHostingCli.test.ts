import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getGitHostingCliStatus } from './gitHostingCli'

const ensureLocalExecutorStarted = vi.hoisted(() => vi.fn())
const requestLocalExecutor = vi.hoisted(() => vi.fn())

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted,
  requestLocalExecutor,
}))

describe('getGitHostingCliStatus', () => {
  beforeEach(() => {
    ensureLocalExecutorStarted.mockReset()
    requestLocalExecutor.mockReset()
    ensureLocalExecutorStarted.mockResolvedValue({ running: true, ready: true })
  })

  test('normalizes the GitHub CLI status from the local executor', async () => {
    requestLocalExecutor.mockResolvedValue({
      success: true,
      stdout: {
        tool: 'gh',
        installed: true,
        authenticated: true,
        executablePath: '/opt/homebrew/bin/gh',
        version: 'gh version 2.80.0',
        detectionError: null,
      },
    })

    await expect(getGitHostingCliStatus('github')).resolves.toEqual({
      provider: 'github',
      tool: 'gh',
      installed: true,
      authenticated: true,
      executablePath: '/opt/homebrew/bin/gh',
      version: 'gh version 2.80.0',
      detectionError: null,
    })
    expect(requestLocalExecutor).toHaveBeenCalledWith('device.execute_command', {
      command_key: 'git_github_cli_status',
      timeout_seconds: 15,
      max_output_bytes: 8192,
    })
  })

  test('reports an unavailable GitLab CLI without requiring authentication', async () => {
    requestLocalExecutor.mockResolvedValue({
      success: true,
      stdout: {
        tool: 'glab',
        installed: false,
        authenticated: false,
        executablePath: null,
        version: null,
      },
    })

    await expect(getGitHostingCliStatus('gitlab')).resolves.toMatchObject({
      provider: 'gitlab',
      tool: 'glab',
      installed: false,
      authenticated: false,
    })
  })

  test('preserves a transient CLI timeout', async () => {
    requestLocalExecutor.mockResolvedValue({
      success: true,
      stdout: {
        tool: 'gh',
        installed: true,
        authenticated: false,
        executablePath: '/opt/homebrew/bin/gh',
        version: null,
        detectionError: 'timeout',
      },
    })

    await expect(getGitHostingCliStatus('github')).resolves.toMatchObject({
      provider: 'github',
      installed: true,
      detectionError: 'timeout',
    })
  })

  test('surfaces local executor command failures', async () => {
    requestLocalExecutor.mockResolvedValue({
      success: false,
      stderr: 'executor unavailable',
    })

    await expect(getGitHostingCliStatus('github')).rejects.toThrow('executor unavailable')
  })
})
