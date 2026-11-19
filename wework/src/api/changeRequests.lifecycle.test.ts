// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { DeviceCommandApi } from './environment'
import { linkedChangeRequestTarget, loadTaskChangeRequests } from './changeRequests'

const url = 'https://github.com/org/app/pull/42'
const target = linkedChangeRequestTarget('local-device', url)!

function viewResponse() {
  return {
    success: true,
    stdout: {
      number: 42,
      url,
      title: 'Lifecycle badge',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      headRefOid: 'view-head',
      statusCheckRollup: { state: 'SUCCESS' },
    },
  }
}

function githubDetails(mergeQueueState: string) {
  return {
    success: true,
    stdout: {
      data: {
        repository: {
          pr0: {
            number: 42,
            url,
            title: 'Lifecycle badge',
            state: 'OPEN',
            isDraft: false,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            reviewDecision: 'APPROVED',
            headRefOid: 'query-head',
            statusCheckRollup: { state: 'SUCCESS' },
            mergeQueueEntry: { state: mergeQueueState },
            timelineItems: { nodes: [] },
          },
        },
      },
    },
  }
}

describe('linked GitHub change request lifecycle', () => {
  it('requests review and head fields and projects the detailed snapshot', async () => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>(async (_device, request) =>
      request.command_key === 'git_github_pull_request_view'
        ? viewResponse()
        : githubDetails('QUEUED')
    )

    const [snapshot] = await loadTaskChangeRequests({ executeCommand }, [target])

    expect(snapshot.changeRequest).toMatchObject({
      checks: 'success',
      mergeStateStatus: 'clean',
      reviewDecision: 'approved',
      mergeQueue: 'queued',
      headSha: 'query-head',
    })
    const query = executeCommand.mock.calls[1][1].args!.join(' ')
    expect(query).toContain('reviewDecision')
    expect(query).toContain('headRefOid')
    expect(query).toContain('mergeQueueEntry')
  })

  it.each([
    ['QUEUED', 'queued'],
    ['AWAITING_CHECKS', 'awaiting_checks'],
    ['CHECKING', 'checking'],
    ['LOCKED', 'locked'],
    ['UNMERGEABLE', 'unmergeable'],
    ['MERGEABLE', 'mergeable'],
    ['FAILED', 'failed'],
    ['TIMED_OUT', 'timed_out'],
  ])('maps merge queue state %s to %s', async (providerState, expected) => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>(async (_device, request) =>
      request.command_key === 'git_github_pull_request_view'
        ? viewResponse()
        : githubDetails(providerState)
    )

    const [snapshot] = await loadTaskChangeRequests({ executeCommand }, [target])

    expect(snapshot.changeRequest?.mergeQueue).toBe(expected)
  })

  it('keeps the visible base state but marks a partial refresh stale when queue enrichment fails', async () => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>(async (_device, request) =>
      request.command_key === 'git_github_pull_request_view'
        ? viewResponse()
        : { success: false, stdout: '', stderr: 'offline' }
    )

    const [snapshot] = await loadTaskChangeRequests({ executeCommand }, [target])

    expect(snapshot).toMatchObject({
      lookupState: 'error',
      stale: true,
      error: 'offline',
      changeRequest: { number: 42, state: 'open', headSha: 'view-head' },
    })
  })
})
