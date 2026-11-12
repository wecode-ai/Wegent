import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import '@/i18n'
import { GroupConversation } from './GroupConversation'
import { groupBoardContext } from './groupWorkspaceApi'

const preference = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => ({
    preferences: { changeRequestStatusEnabled: preference.enabled },
  }),
}))
const group = { id: 'group', name: 'Design', status: 'active', role: 'Viewer' } as ChatGroup
const url = 'https://github.com/org/app/pull/42'
const item = {
  id: 'thread',
  group_id: group.id,
  cloud_project_id: group.id,
  title: 'Review',
  sequence_number: 1,
  status: 'pending',
  badges: [{ id: 'pr-42', label: '#42', url, icon: 'git-pull-request' }],
} as CollaborationIssue

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Thread header PR status lookup', () => {
  it.each([true, false])(
    'uses the host command API while respecting lookup preference=%s',
    async enabled => {
      preference.enabled = enabled
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
      const executeCommand = vi.fn().mockResolvedValue({
        success: true,
        stdout: { number: 42, url, title: 'Fix', state: 'MERGED' },
      })
      const api = {} as SharedWorkspaceApi
      const view = render(
        <GroupConversation
          group={group}
          project={groupBoardContext(group, 'local')}
          item={item}
          items={[item]}
          api={api}
          catalog={api}
          members={[]}
          chat={undefined}
          locale="zh-CN"
          changeRequestApi={{ executeCommand }}
          groups={
            {
              participation: vi.fn(async () => ({
                current_user_id: 8,
                participants: [],
                joined: false,
                can_comment: false,
                show_in_sidebar: false,
              })),
            } as unknown as ChatGroupApi
          }
          onOpenThread={vi.fn()}
          onBack={vi.fn()}
          onChanged={vi.fn()}
          onClearFocus={vi.fn()}
        />
      )
      expect(executeCommand).not.toHaveBeenCalled()
      await act(async () => {
        callbacks.forEach(callback =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver
          )
        )
      })
      if (enabled) {
        expect(executeCommand).toHaveBeenCalledTimes(1)
        expect(screen.getByTestId('issue-badge-pr-42')).toHaveAccessibleName(/已合并|Merged/)
      } else {
        expect(executeCommand).not.toHaveBeenCalled()
        expect(screen.getByTestId('issue-badge-pr-42')).toHaveAttribute('title', '#42')
      }
      expect(item.badges![0]).not.toHaveProperty('tooltip')
      view.unmount()
    }
  )
})
