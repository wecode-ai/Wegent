import { describe, expect, test, vi } from 'vitest'
import type { ExecutorClient } from '@/api/executorAccess'
import { isMatchingGitCheckout, normalizeGitRepositoryUrl } from './useWorkbenchProjectActions'

type ExecuteCommand = ExecutorClient['commands']['executeCommand']

function commandResponse(stdout: string) {
  return {
    success: true,
    exit_code: 0,
    stdout,
    stderr: '',
  }
}

describe('Git project clone recovery', () => {
  test('normalizes optional Git suffixes', () => {
    expect(normalizeGitRepositoryUrl('https://github.com/owner/repo.git/')).toBe(
      'https://github.com/owner/repo'
    )
  })

  test('accepts an existing checkout of the requested repository and branch', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce(commandResponse('https://github.com/owner/repo.git\n'))
      .mockResolvedValueOnce(commandResponse('develop\n')) as unknown as ExecuteCommand

    await expect(
      isMatchingGitCheckout(
        executeCommand,
        'device-1',
        '/workspace/repo',
        'https://github.com/owner/repo.git',
        'develop'
      )
    ).resolves.toBe(true)
  })

  test('rejects an existing checkout of a different repository', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValue(
        commandResponse('https://github.com/other/repo.git\n')
      ) as unknown as ExecuteCommand

    await expect(
      isMatchingGitCheckout(
        executeCommand,
        'device-1',
        '/workspace/repo',
        'https://github.com/owner/repo.git'
      )
    ).resolves.toBe(false)
  })
})
