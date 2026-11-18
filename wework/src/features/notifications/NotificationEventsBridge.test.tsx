import { act, cleanup, render } from '@testing-library/react'
import { StrictMode, useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createAppRouteSession } from '@/appRouteSession'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { useTranslation } from '@/hooks/useTranslation'

const { send, windowLabel, t } = vi.hoisted(() => ({
  send: vi.fn(),
  windowLabel: vi.fn(() => 'main'),
  t: (key: string) => key,
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/lib/runtime-environment', () => ({
  getDesktopWindowLabel: windowLabel,
  isElectronRuntime: () => false,
}))
vi.mock('@/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@/features/workbench/runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: send,
}))
function NotificationEventsBridge({
  chatStream,
  currentUserId,
  localUserId,
}: Pick<WorkbenchServices, 'chatStream'> & { currentUserId?: number; localUserId?: number }) {
  const { t } = useTranslation('common')
  const [session] = useState(() =>
    createAppRouteSession({
      tabs: null,
      lifecycleStore: new RuntimeTaskLifecycleStore('notification-test-account'),
    })
  )
  const notifications = useMemo(
    () => ({ chatStream, currentUserId, localUserId, t }),
    [chatStream, currentUserId, localUserId, t]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      session.subscribe(listener, { pathname: '/', search: '' }, false, {}, true, notifications),
    [session, notifications]
  )
  const mounted = useSyncExternalStore(subscribe, session.getSnapshot, session.getSnapshot)
  return <output>{mounted.ids.size}</output>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('application notification events', () => {
  it.each(['0', '1'])(
    'notifies local identity %s without an open Issue and deduplicates replayed assignments',
    recipientUserId => {
      windowLabel.mockReturnValue('main')
      let handlers!: ChatStreamHandlers
      const chatStream = {
        subscribe: (listener: ChatStreamHandlers) => {
          handlers = listener
          return () => {}
        },
      } as WorkbenchServices['chatStream']
      render(<NotificationEventsBridge chatStream={chatStream} currentUserId={1} localUserId={0} />)
      const assignment = {
        projectStore: 'local' as const,
        projectId: 'local-project',
        projectName: 'Offline project',
        itemId: 'OFF-1',
        itemTitle: 'Inspect memory',
        assignerName: 'Coordinator',
        assignmentId: 'human-assignment-1',
        recipientUserId,
      }
      act(() => {
        handlers.onProjectTaskAssigned?.({ ...assignment, recipientUserId: '2' })
      })
      expect(send).not.toHaveBeenCalled()
      act(() => {
        handlers.onProjectTaskAssigned?.(assignment)
        handlers.onProjectTaskAssigned?.(assignment)
      })
      expect(send).toHaveBeenCalledExactlyOnceWith({
        title: 'workbench.project_task_assigned_notification_title',
        body: 'workbench.project_task_assigned_notification_body',
        url: 'wework://boards/local/local-project/issues/OFF-1',
      })
    }
  )

  it.each(['main', 'workspace-1'])(
    'owns one subscription and limits system delivery: %s',
    async label => {
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
      if (label === 'main') {
        expect(send).toHaveBeenCalledWith({
          title: 'workbench.project_task_assigned_notification_title',
          body: 'workbench.project_task_assigned_notification_body',
          url: 'wework://boards/12/issues/ISSUE-1',
        })
      }
      view.unmount()
      await Promise.resolve()
      expect(listeners.size).toBe(0)
      window.removeEventListener('wework-notifications-changed', refresh)
    }
  )
})
