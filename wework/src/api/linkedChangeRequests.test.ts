import { describe, expect, it, vi } from 'vitest'
import type { DeviceCommandApi } from './environment'
import { linkedChangeRequestTarget, loadTaskChangeRequests } from './changeRequests'

describe('linked change requests', () => {
  it('bounds concurrent CLI lookups while preserving the target order', async () => {
    let active = 0
    let peak = 0
    const pending: Array<() => void> = []
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>((_device, input) => {
      active += 1
      peak = Math.max(peak, active)
      const url = input.args![0]
      return new Promise(resolve => {
        pending.push(() => {
          active -= 1
          resolve({
            success: true,
            stdout: { number: Number(url.split('/').at(-1)), url, state: 'OPEN' },
          })
        })
      })
    })
    const targets = Array.from(
      { length: 9 },
      (_, index) =>
        linkedChangeRequestTarget('local-device', `https://github.com/org/app/pull/${index + 1}`)!
    )
    const result = loadTaskChangeRequests({ executeCommand }, targets)
    expect(executeCommand).toHaveBeenCalledTimes(4)
    pending.splice(0).forEach(resolve => resolve())
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(8))
    pending.splice(0).forEach(resolve => resolve())
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(9))
    pending.splice(0).forEach(resolve => resolve())
    expect((await result).map(snapshot => snapshot.changeRequest?.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
    expect(peak).toBe(4)
  })

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
