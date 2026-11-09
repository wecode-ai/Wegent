import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { LOCAL_USER } from '@/api/local/localSession'
import { MobileDrawer } from './MobileDrawer'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'

describe('MobileDrawer task loading', () => {
  test.each(['loading', 'error'] as const)(
    'distinguishes %s from a successful empty list',
    async phase => {
      const onRetry = vi.fn().mockResolvedValue(undefined)
      const store = new RuntimeTaskLifecycleStore('mobile-drawer-loading-test')
      const { rerender } = render(
        <MobileDrawer
          open
          user={LOCAL_USER}
          projects={[]}
          runtimeWork={null}
          runtimeWorkLoad={{ phase, error: phase === 'error' ? 'Request timed out' : null }}
          onClose={vi.fn()}
          onSelectProject={vi.fn()}
          onRefreshWorkLists={onRetry}
        />,
        {
          wrapper: ({ children }) => (
            <RuntimeTaskLifecycleProvider store={store}>{children}</RuntimeTaskLifecycleProvider>
          ),
        }
      )
      expect(screen.getByTestId('runtime-work-load-status')).toBeInTheDocument()
      expect(screen.queryByTestId('mobile-runtime-chat-empty')).not.toBeInTheDocument()
      if (phase === 'error') {
        await userEvent.click(screen.getByTestId('runtime-work-load-retry'))
        expect(onRetry).toHaveBeenCalledOnce()
      }
      rerender(
        <MobileDrawer
          open
          user={LOCAL_USER}
          projects={[]}
          runtimeWork={{ projects: [], chats: [], totalTasks: 0 }}
          runtimeWorkLoad={{ phase: 'ready', error: null }}
          onClose={vi.fn()}
          onSelectProject={vi.fn()}
        />
      )
      expect(screen.getByTestId('mobile-runtime-chat-empty')).toHaveTextContent('暂无会话')
      expect(screen.queryByTestId('runtime-work-load-status')).not.toBeInTheDocument()
    }
  )
})
