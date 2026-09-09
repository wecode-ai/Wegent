import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { NotificationEventsBridge } from './NotificationEventsBridge'

const { send, windowLabel, t } = vi.hoisted(() => ({
  send: vi.fn(),
  windowLabel: vi.fn(() => 'main'),
  t: (key: string) => key,
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: windowLabel }))
vi.mock('@/features/workbench/runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: send,
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('application notification events', () => {
  it.each(['main', 'workspace-1'])(
    'owns one subscription and limits system delivery: %s',
    label => {
      windowLabel.mockReturnValue(label)
      const listeners = new Set<ChatStreamHandlers>()
      const chatStream = {
        subscribe: (handlers: ChatStreamHandlers) => {
          listeners.add(handlers)
          return () => {
            listeners.delete(handlers)
          }
        },
      } as WorkbenchServices['chatStream']
      const refresh = vi.fn()
      window.addEventListener('wework-notifications-changed', refresh)
      const view = render(
        <StrictMode>
          <NotificationEventsBridge chatStream={chatStream} />
        </StrictMode>
      )
      expect(listeners.size).toBe(1)
      act(() => {
        for (const handlers of listeners) {
          handlers.onWeworkNotification?.()
          handlers.onProjectTaskAssigned?.({
            projectId: '12',
            projectName: 'Project',
            itemId: 'ISSUE-1',
            itemTitle: 'Review',
            assignerName: 'Alice',
          })
        }
      })
      expect(refresh).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledTimes(label === 'main' ? 1 : 0)
      view.unmount()
      expect(listeners.size).toBe(0)
      window.removeEventListener('wework-notifications-changed', refresh)
    }
  )
})
