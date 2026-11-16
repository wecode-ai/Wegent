import type { CloudLoopItem } from '@/api/deliveries'
import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'
import { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import '@/i18n'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('does not display or query badges without detail permission', () => {
    observeVisibility()
    const executeCommand = vi.fn()
    const monitor = new ChangeRequestMonitor({ executeCommand })
    render(
      <CloudTodoBoardCard
        projectStore="backend"
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
