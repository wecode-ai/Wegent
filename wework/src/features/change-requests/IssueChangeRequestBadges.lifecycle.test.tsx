import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { DeviceCommandApi } from '@/api/environment'
import { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import {
  CHANGE_REQUEST_LIFECYCLE_BADGE_FLAG,
  IssueChangeRequestBadges,
} from './IssueChangeRequestBadges'

const url = 'https://github.com/org/app/pull/42'
const badge = Object.freeze({ id: 'pr-42', label: '#42', url, icon: 'git-pull-request' })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete window.__WEWORK_RUNTIME_CONFIG__
})

function observeIntersections() {
  const callbacks: IntersectionObserverCallback[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback)
      }
      observe() {}
      disconnect() {}
    }
  )
  return async (visible: boolean) =>
    act(() =>
      callbacks.forEach(callback =>
        callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
    )
}

function view(number: number, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    stdout: {
      number,
      url: `https://github.com/org/app/pull/${number}`,
      title: `Pull request ${number}`,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      headRefOid: `head-${number}`,
      statusCheckRollup: { state: 'SUCCESS' },
      updatedAt: '2026-11-18T08:00:00Z',
      ...overrides,
    },
  }
}

function githubDetails(number: number, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    stdout: {
      data: {
        repository: {
          pr0: {
            ...view(number).stdout,
            mergeQueueEntry: null,
            timelineItems: { nodes: [] },
            ...overrides,
          },
        },
      },
    },
  }
}

function commandApi(
  views: Record<number, Record<string, unknown>>,
  details: Record<number, Record<string, unknown>> = {}
) {
  return vi.fn<DeviceCommandApi['executeCommand']>(async (_device, request) => {
    if (request.command_key === 'git_github_pull_request_view') {
      const number = Number(request.args![0].match(/\/pull\/(\d+)$/)?.[1])
      return views[number] ?? { success: false, stdout: '', stderr: 'missing' }
    }
    if (request.command_key === 'git_github_pull_request_merge_queue_batch') {
      const query = request.args!.join(' ')
      const number = Number(query.match(/pullRequest\(number: (\d+)\)/)?.[1])
      return githubDetails(number, details[number])
    }
    return { success: false, stdout: '', stderr: 'unexpected command' }
  })
}

describe('Issue change request lifecycle badges', () => {
  it('renders merged as visible purple completion with full detail text', async () => {
    const setVisible = observeIntersections()
    const monitor = new ChangeRequestMonitor({
      executeCommand: commandApi({
        42: view(42, {
          state: 'MERGED',
          mergedAt: '2026-11-18T09:00:00Z',
          reviewDecision: 'CHANGES_REQUESTED',
          mergeStateStatus: 'DIRTY',
          statusCheckRollup: { state: 'FAILURE' },
        }),
      }),
    })
    render(<IssueChangeRequestBadges badges={[badge]} monitor={monitor} compact />)

    await setVisible(true)
    const element = await screen.findByTestId('issue-badge-pr-42')

    await waitFor(() => expect(element).toHaveTextContent(/#42 · 已合并|#42 · Merged/))
    expect(element).toHaveClass('text-merged')
    expect(element).toHaveAttribute('title', expect.stringMatching(/Pull request 42/))
    expect(element).toHaveAttribute('title', expect.stringMatching(/Review|评审/))
    expect(element).toHaveAttribute('title', expect.stringMatching(/Merge state|合并状态/))
    expect(element).toHaveAttribute('title', expect.stringMatching(/head-42/))
    expect(element).toHaveAttribute('title', expect.stringMatching(/Updated|更新时间/))
    expect(element).toHaveAccessibleName(/#42 · 已合并|#42 · Merged/)
    expect(element).toHaveAccessibleName(/head-42/)
  })

  it('uses readable text and distinct tones across blocking and waiting states', async () => {
    const setVisible = observeIntersections()
    const badges = [42, 43, 44, 45, 46, 47, 48, 49].map(number => ({
      id: `pr-${number}`,
      label: `#${number}`,
      url: `https://github.com/org/app/pull/${number}`,
    }))
    const monitor = new ChangeRequestMonitor({
      executeCommand: commandApi(
        {
          42: view(42, { mergeStateStatus: 'DIRTY', statusCheckRollup: { state: 'FAILURE' } }),
          43: view(43, { statusCheckRollup: { state: 'ERROR' } }),
          44: view(44, {
            mergeStateStatus: 'BLOCKED',
            reviewDecision: 'REVIEW_REQUIRED',
          }),
          45: view(45, { isDraft: true }),
          46: view(46, { statusCheckRollup: { state: 'PENDING' } }),
          47: view(47),
          48: view(48, { state: 'CLOSED' }),
          49: view(49, { state: 'MERGED', mergedAt: '2026-11-18T09:00:00Z' }),
        },
        {
          42: { mergeStateStatus: 'DIRTY', statusCheckRollup: { state: 'FAILURE' } },
          43: { statusCheckRollup: { state: 'ERROR' } },
          44: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' },
          45: { isDraft: true },
          46: { statusCheckRollup: { state: 'PENDING' } },
        }
      ),
    })
    render(<IssueChangeRequestBadges badges={badges} monitor={monitor} compact />)

    await setVisible(true)
    await waitFor(() =>
      expect(screen.getByTestId('issue-badge-pr-49')).toHaveTextContent(/#49 · 已合并|#49 · Merged/)
    )

    expect(screen.getByTestId('issue-badge-pr-42')).toHaveTextContent(/冲突|Conflict/)
    expect(screen.getByTestId('issue-badge-pr-43')).toHaveTextContent(/检查失败|Failed/)
    expect(screen.getByTestId('issue-badge-pr-44')).toHaveTextContent(/阻塞|Blocked/)
    expect(screen.getByTestId('issue-badge-pr-45')).toHaveTextContent(/草稿|Draft/)
    expect(screen.getByTestId('issue-badge-pr-46')).toHaveTextContent(/检查中|Checking/)
    expect(screen.getByTestId('issue-badge-pr-47')).toHaveTextContent(/通过|Ready/)
    expect(screen.getByTestId('issue-badge-pr-48')).toHaveTextContent(/已关闭|Closed/)
    expect(screen.getByTestId('issue-badge-pr-49')).toHaveTextContent(/已合并|Merged/)

    for (const id of ['pr-42', 'pr-43', 'pr-44', 'pr-48']) {
      expect(screen.getByTestId(`issue-badge-${id}`)).toHaveClass('text-destructive')
    }
    expect(screen.getByTestId('issue-badge-pr-45')).toHaveClass('text-text-secondary')
    expect(screen.getByTestId('issue-badge-pr-46')).toHaveClass('text-warning')
    expect(screen.getByTestId('issue-badge-pr-47')).toHaveClass('text-success')
    expect(screen.getByTestId('issue-badge-pr-49')).toHaveClass('text-merged')
  })

  it('preserves the last non-green state and marks it stale after refresh failure', async () => {
    vi.useFakeTimers()
    const setVisible = observeIntersections()
    let fail = false
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>(async (_device, request) => {
      if (fail) return { success: false, stdout: '', stderr: 'offline' }
      return request.command_key === 'git_github_pull_request_view'
        ? view(42, { statusCheckRollup: { state: 'FAILURE' } })
        : githubDetails(42, { statusCheckRollup: { state: 'FAILURE' } })
    })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    render(<IssueChangeRequestBadges badges={[badge]} monitor={monitor} compact />)

    await setVisible(true)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveTextContent(/检查失败|Failed/)
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveClass('text-destructive')

    fail = true
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveTextContent(/检查失败|Failed/)
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveClass('text-destructive')
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(/过期|Stale/i)
  })

  it('shows unknown when an initial lookup fails and does not query offscreen', async () => {
    const setVisible = observeIntersections()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockResolvedValue({ success: false, stdout: '', stderr: 'offline' })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    render(<IssueChangeRequestBadges badges={[badge]} monitor={monitor} compact />)

    expect(executeCommand).not.toHaveBeenCalled()
    await setVisible(true)
    await waitFor(() =>
      expect(screen.getByTestId('issue-badge-pr-42')).toHaveTextContent(/未知|Unknown/)
    )
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveClass('text-text-secondary')
  })

  it('shares one lookup for the same visible PR', async () => {
    const setVisible = observeIntersections()
    const executeCommand = commandApi({ 42: view(42) })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    render(
      <>
        <IssueChangeRequestBadges badges={[badge]} monitor={monitor} compact />
        <IssueChangeRequestBadges badges={[badge]} monitor={monitor} compact />
      </>
    )

    await setVisible(true)
    await waitFor(() => expect(screen.getAllByTestId('issue-badge-pr-42')).toHaveLength(2))
    expect(
      executeCommand.mock.calls.filter(
        ([, request]) => request.command_key === 'git_github_pull_request_view'
      )
    ).toHaveLength(1)
  })

  it('can restore the legacy presentation through the lifecycle feature flag', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      featureFlags: { [CHANGE_REQUEST_LIFECYCLE_BADGE_FLAG]: false },
    }
    const setVisible = observeIntersections()
    const monitor = new ChangeRequestMonitor({
      executeCommand: commandApi({
        42: view(42, { state: 'MERGED', mergedAt: '2026-11-18T09:00:00Z' }),
      }),
    })
    render(<IssueChangeRequestBadges badges={[badge]} monitor={monitor} compact />)

    await setVisible(true)
    await waitFor(() => expect(screen.getByTestId('issue-badge-pr-42')).toHaveClass('text-success'))
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveTextContent('#42')
    expect(screen.getByTestId('issue-badge-pr-42')).not.toHaveTextContent(/已合并|Merged/)
  })
})
