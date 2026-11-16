import { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import '@/i18n'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueChangeRequestBadges } from './IssueChangeRequestBadges'
import { createConnectionObserverFixture } from '@/test/connection-observer'
import { outputAsRecord } from '@/api/environment'
import type { DeviceCommandRequest, DeviceCommandResponse } from '@/types/api'

const url = 'https://github.com/org/app/pull/42'
const badges = [Object.freeze({ id: 'pr-42', label: '#42', url, icon: 'git-pull-request' })]

function protocolReplies() {
  const reply = createConnectionObserverFixture()
  return (request: DeviceCommandRequest, state = 'OPEN') => {
    const response = reply(request)
    const observation = outputAsRecord(outputAsRecord(response.stdout)?.observation)
    if (Array.isArray(observation?.resourceStates)) {
      for (const resource of observation.resourceStates) {
        const data = outputAsRecord(resource.data)
        if (data) data.state = state
      }
    }
    return response
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function visibility() {
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
    act(async () =>
      callbacks.forEach(callback =>
        callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
    )
}

describe('client PR badge adapter', () => {
  it('automatically updates generic badges with the shared refresh timer, then stops offscreen', async () => {
    vi.useFakeTimers()
    const setVisible = visibility()
    const reply = protocolReplies()
    const executeCommand = vi.fn().mockImplementation(async (_device, request) => reply(request))
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const view = render(<IssueChangeRequestBadges badges={badges} monitor={monitor} compact />)
    expect(executeCommand).not.toHaveBeenCalled()
    await setVisible(true)
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(/等待处理|Awaiting action/)
    expect(executeCommand).toHaveBeenCalledTimes(1)
    executeCommand.mockImplementation(async (_device, request) => reply(request, 'MERGED'))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(/已合并|Merged/)
    expect(executeCommand).toHaveBeenCalledTimes(2)
    await setVisible(false)
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(executeCommand.mock.calls.map(([, request]) => request.command_key)).toEqual([
      'connection_observer_start',
      'connection_observer_renew',
      'connection_observer_stop',
    ])
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveTextContent('#42')
    expect(badges[0]).not.toHaveProperty('tooltip')
    view.unmount()
  })

  it('shares one lookup across cards and preserves the last status when refresh fails', async () => {
    vi.useFakeTimers()
    const setVisible = visibility()
    const reply = protocolReplies()
    const executeCommand = vi
      .fn()
      .mockImplementation(async (_device, request) => reply(request, 'MERGED'))
    const monitor = new ChangeRequestMonitor({ executeCommand })
    render(
      <>
        <IssueChangeRequestBadges badges={badges} monitor={monitor} compact />
        <IssueChangeRequestBadges badges={badges} monitor={monitor} compact />
      </>
    )
    await setVisible(true)
    expect(executeCommand).toHaveBeenCalledTimes(1)
    executeCommand.mockResolvedValue({ success: false, stderr: 'offline' })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getAllByTestId('issue-badge-pr-42')).toHaveLength(2)
    for (const badge of screen.getAllByTestId('issue-badge-pr-42')) {
      expect(badge).toHaveAccessibleName(/已合并|Merged/)
      expect(badge).toHaveAccessibleName(/过期|旧|stale|outdated/i)
    }
  })

  it('shows loading before the first observation and reports missing authorization accurately', async () => {
    const setVisible = visibility()
    let resolve!: (result: DeviceCommandResponse) => void
    const pending = new Promise<DeviceCommandResponse>(res => {
      resolve = res
    })
    const executeCommand = vi.fn().mockReturnValue(pending)
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const view = render(<IssueChangeRequestBadges badges={badges} monitor={monitor} compact />)
    try {
      await setVisible(true)
      expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(
        /正在查询状态|Loading status/i
      )
      await act(async () => {
        resolve({ success: false, stdout: '', stderr: 'connector_auth_required' })
        await monitor.refresh()
      })
      expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(/授权|登录|authenticat/i)
    } finally {
      view.unmount()
    }
  })
})
