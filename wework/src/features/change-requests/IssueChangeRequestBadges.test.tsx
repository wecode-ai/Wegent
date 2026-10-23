import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import { IssueChangeRequestBadges } from './IssueChangeRequestBadges'

const url = 'https://github.com/org/app/pull/42'
const badges = [Object.freeze({ id: 'pr-42', label: '#42', url, icon: 'git-pull-request' })]

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
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: { number: 42, url, title: 'Fix', state: 'OPEN' },
    })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const view = render(<IssueChangeRequestBadges badges={badges} monitor={monitor} compact />)
    expect(executeCommand).not.toHaveBeenCalled()
    await setVisible(true)
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(/等待处理|Awaiting action/)
    expect(executeCommand).toHaveBeenCalledTimes(1)
    executeCommand.mockResolvedValue({
      success: true,
      stdout: { number: 42, url, title: 'Fix', state: 'MERGED' },
    })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(/已合并|Merged/)
    expect(executeCommand).toHaveBeenCalledTimes(2)
    await setVisible(false)
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveTextContent('#42')
    expect(badges[0]).not.toHaveProperty('tooltip')
    view.unmount()
  })

  it('shares one lookup across cards and preserves the last status when refresh fails', async () => {
    vi.useFakeTimers()
    const setVisible = visibility()
    const executeCommand = vi
      .fn()
      .mockResolvedValue({ success: true, stdout: { number: 42, url, state: 'MERGED' } })
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

  it('keeps saved badges when lookup is disabled and does not subscribe', () => {
    const executeCommand = vi.fn()
    render(
      <AppPreferencesContext.Provider
        value={{
          loaded: true,
          preferences: { ...defaultAppPreferences, changeRequestStatusEnabled: false },
        }}
      >
        <IssueChangeRequestBadges badges={badges} api={{ executeCommand }} compact />
      </AppPreferencesContext.Provider>
    )
    expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName('#42')
    expect(executeCommand).not.toHaveBeenCalled()
  })
})
