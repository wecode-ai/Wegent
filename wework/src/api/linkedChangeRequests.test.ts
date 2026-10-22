import { describe, expect, it, vi } from 'vitest'
import { linkedChangeRequestTarget, loadTaskChangeRequests } from './changeRequests'

describe('linked change requests', () => {
  it.each([
    [
      'https://github.com/org/repo/pull/123456',
      'github',
      {
        number: 123456,
        url: 'https://github.com/org/repo/pull/123456',
        state: 'OPEN',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
      'failure',
    ],
    [
      'https://gitlab.internal:8443/group/sub/repo/-/merge_requests/7',
      'gitlab',
      {
        iid: 7,
        web_url: 'https://gitlab.internal:8443/group/sub/repo/-/merge_requests/7',
        state: 'opened',
        head_pipeline: { status: 'success' },
      },
      'success',
    ],
  ] as const)(
    'queries the exact request, independent of checkout and list limits: %s',
    async (url, provider, stdout, checks) => {
      const executeCommand = vi.fn().mockResolvedValue({ success: true, stdout })
      const target = linkedChangeRequestTarget('local-device', url)!
      const [snapshot] = await loadTaskChangeRequests({ executeCommand }, [target])
      expect(snapshot.changeRequest).toMatchObject({ provider, checks })
      expect(executeCommand).toHaveBeenCalledOnce()
      expect(executeCommand).toHaveBeenCalledWith(
        'local-device',
        expect.objectContaining({
          command_key:
            provider === 'github'
              ? 'git_github_pull_request_view'
              : 'git_gitlab_merge_request_view',
          args:
            provider === 'github'
              ? [url]
              : ['7', '--repo', 'https://gitlab.internal:8443/group/sub/repo'],
        })
      )
      expect(executeCommand.mock.calls[0][1]).not.toHaveProperty('path')
    }
  )

  it('isolates failed requests so other links can still show status', async () => {
    const executeCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        success: true,
        stdout: { number: 2, url: 'https://github.com/org/repo/pull/2', state: 'CLOSED' },
      })
    const targets = [1, 2].map(
      number =>
        linkedChangeRequestTarget('local-device', `https://github.com/org/repo/pull/${number}`)!
    )
    const snapshots = await loadTaskChangeRequests({ executeCommand }, targets)
    expect(snapshots[0]).toMatchObject({
      lookupState: 'error',
      changeRequest: null,
      error: 'offline',
    })
    expect(snapshots[1].changeRequest?.state).toBe('closed')
  })

  it('rejects non-PR and unsafe addresses', () => {
    for (const url of [
      'file:///org/repo/pull/1',
      'https://user:secret@github.com/org/repo/pull/1',
      'https://github.com/org/repo/issues/1',
      'https://github.com/org/repo/pull/0',
      'https://github.com/org/repo/pull/9007199254740993',
    ]) {
      expect(linkedChangeRequestTarget('local-device', url)).toBeNull()
    }
  })
})
