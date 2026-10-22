import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem } from '@/api/deliveries'
import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'
import { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import { CloudTodoBoardCard } from './CloudTodoBoardCard'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})
const url = 'https://github.com/org/app/pull/42'
const item = {
  id: 'issue-1',
  cloud_project_id: 'project-1',
  title: 'PR status on the board',
  description: '',
  status: 'completed',
  priority: 'none',
  can_view_detail: true,
  version: 1,
  badges: [{ id: url, label: '#42', url, icon: 'git-pull-request' }],
} as CloudLoopItem
const display = { showAssignee: false, showPriority: false, showTags: false, showDate: false }

function observeVisibility() {
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
  return (visible: boolean) =>
    act(() =>
      callbacks.forEach(callback =>
        callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
    )
}

describe('Issue board metadata badges', () => {
  it('does not discover links in historical content while rendering a card', () => {
    const executeCommand = vi.fn()
    const monitor = new ChangeRequestMonitor({ executeCommand })
    render(
      <CloudTodoBoardCard
        item={{ ...item, badges: undefined, description: url }}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={display}
        renderBadges={badges => (
          <IssueChangeRequestBadges badges={badges} monitor={monitor} compact />
        )}
      />
    )
    expect(screen.queryByTestId('cloud-todo-card-badges-issue-1')).not.toBeInTheDocument()
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('renders metadata without hydrating descriptions or comments and queries only visible cards', async () => {
    const setVisible = observeVisibility()
    const executeCommand = vi
      .fn()
      .mockResolvedValue({ success: true, stdout: { number: 42, url, state: 'MERGED' } })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const onClick = vi.fn()
    render(
      <CloudTodoBoardCard
        item={item}
        onClick={onClick}
        onArchive={vi.fn()}
        display={display}
        renderBadges={badges => (
          <IssueChangeRequestBadges badges={badges} monitor={monitor} compact />
        )}
      />
    )
    expect(screen.getByText('#42')).toBeVisible()
    expect(executeCommand).not.toHaveBeenCalled()
    setVisible(true)
    await waitFor(() =>
      expect(screen.getByTestId('issue-badge-' + url)).toHaveAccessibleName(/已合并|Merged/)
    )
    expect(executeCommand).toHaveBeenCalledTimes(1)
    setVisible(false)
    expect(screen.getByText('#42')).toBeVisible()
  })

  it('does not display or query badges without detail permission', () => {
    observeVisibility()
    const executeCommand = vi.fn()
    const monitor = new ChangeRequestMonitor({ executeCommand })
    render(
      <CloudTodoBoardCard
        item={{ ...item, can_view_detail: false }}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={display}
        renderBadges={badges => (
          <IssueChangeRequestBadges badges={badges} monitor={monitor} compact />
        )}
      />
    )
    expect(screen.queryByText('#42')).not.toBeInTheDocument()
    expect(executeCommand).not.toHaveBeenCalled()
  })
})
