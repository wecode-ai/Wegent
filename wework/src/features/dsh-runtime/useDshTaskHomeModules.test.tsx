import { Component, Suspense, use, type ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { clearDshUiModuleCache, importDshUiModule } from './dshUiModules'
import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'
import { useDshTaskHomeModules } from './useDshTaskHomeModules'

describe('active task home module loading', () => {
  let entries: WeworkDshSlotEntry[]
  let notify: (() => void) | undefined

  beforeEach(() => {
    clearDshUiModuleCache()
    entries = [{ id: 'current-home', module: 'plugins/current-home.js' }]
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.home ? entries : []),
      subscribe: (slot, listener) => {
        if (slot === WEWORK_DSH_SLOTS.home) notify = listener
        return () => {}
      },
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }
  })

  afterEach(() => {
    delete window.__WEWORK_DSH_UI__
    delete window.__WEWORK_DSH_UI_MODULES__
  })

  function TaskApp() {
    use(importDshUiModule('plugins/task-app.js'))
    return <span>Task app ready</span>
  }

  function Surface({ activeTask }: { activeTask: boolean }) {
    useDshTaskHomeModules(activeTask)
    return (
      <Suspense fallback={<span>Task app loading</span>}>
        <TaskApp />
      </Suspense>
    )
  }

  test('loads the registered home while the task app is still pending and shares its promise', async () => {
    const home = vi.fn(() => new Promise(() => {}))
    const inactiveHome = vi.fn(() => Promise.resolve({}))
    window.__WEWORK_DSH_UI_MODULES__ = {
      'plugins/task-app.js': () => new Promise(() => {}),
      'plugins/current-home.js': home,
      'plugins/inactive-home.js': inactiveHome,
    }

    await act(async () => {
      render(<Surface activeTask />)
    })

    expect(screen.getByText('Task app loading')).toBeInTheDocument()
    expect(home).toHaveBeenCalledTimes(1)
    expect(inactiveHome).not.toHaveBeenCalled()
    const first = importDshUiModule('plugins/current-home.js')
    expect(importDshUiModule('plugins/current-home.js')).toBe(first)
    expect(home).toHaveBeenCalledTimes(1)
  })

  test('does not request home modules for board or hidden task surfaces', async () => {
    const home = vi.fn(() => Promise.resolve({}))
    window.__WEWORK_DSH_UI_MODULES__ = {
      'plugins/task-app.js': {},
      'plugins/current-home.js': home,
    }

    await act(async () => {
      render(<Surface activeTask={false} />)
    })
    expect(home).not.toHaveBeenCalled()
  })

  test('requests the new registered home when the active plugin contribution changes', async () => {
    const currentHome = vi.fn(() => Promise.resolve({}))
    const nextHome = vi.fn(() => Promise.resolve({}))
    window.__WEWORK_DSH_UI_MODULES__ = {
      'plugins/task-app.js': {},
      'plugins/current-home.js': currentHome,
      'plugins/next-home.js': nextHome,
    }
    await act(async () => {
      render(<Surface activeTask />)
    })
    expect(currentHome).toHaveBeenCalledTimes(1)
    expect(nextHome).not.toHaveBeenCalled()

    await act(async () => {
      entries = [{ id: 'next-home', module: 'plugins/next-home.js' }]
      notify?.()
    })
    expect(nextHome).toHaveBeenCalledTimes(1)
    expect(currentHome).toHaveBeenCalledTimes(1)
  })

  test('surfaces a failed home import instead of silently rendering a ready task surface', async () => {
    class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      render() {
        return this.state.failed ? <span>Home import failed</span> : this.props.children
      }
    }
    window.__WEWORK_DSH_UI_MODULES__ = {
      'plugins/task-app.js': () => new Promise(() => {}),
      'plugins/current-home.js': () => Promise.reject(new Error('Home module unavailable')),
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await act(async () => {
        render(
          <ErrorBoundary>
            <Surface activeTask />
          </ErrorBoundary>
        )
      })
      expect(screen.getByText('Home import failed')).toBeInTheDocument()
      expect(screen.queryByText('Task app ready')).not.toBeInTheDocument()
    } finally {
      error.mockRestore()
    }
  })
})
