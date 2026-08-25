import { describe, expect, test, vi } from 'vitest'
import {
  attachRightWorkspaceSidebarController,
  encodeRightWorkspaceExtensionTabId,
  rightWorkspaceBetterSidebar,
  rightWorkspaceExtensionContext,
} from './rightWorkspaceSidebarRegistry'

describe('rightWorkspaceBetterSidebar', () => {
  test('registers and disposes DSH better-sidebar compatible tab descriptors', () => {
    const listener = vi.fn()
    const unsubscribe = rightWorkspaceBetterSidebar.subscribe(listener)
    const descriptor = {
      id: 'test:inspector',
      title: 'Inspector',
      component: () => null,
    }

    const dispose = rightWorkspaceBetterSidebar.registerTab(descriptor)
    expect(rightWorkspaceBetterSidebar.getTab(descriptor.id)).toBe(descriptor)
    expect(rightWorkspaceBetterSidebar.getTabs()).toContain(descriptor)
    expect(listener).toHaveBeenCalledTimes(1)

    dispose()
    expect(rightWorkspaceBetterSidebar.getTab(descriptor.id)).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  test('routes stateful operations to the active or explicitly targeted Wework pane', () => {
    const openPrimary = vi.fn()
    const openSecondary = vi.fn()
    const updatePrimary = vi.fn()
    const stateListener = vi.fn()
    const unsubscribeState = rightWorkspaceBetterSidebar.subscribeState(stateListener)
    const attachPrimary = attachRightWorkspaceSidebarController({
      active: () => true,
      openTab: openPrimary,
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      updateTab: updatePrimary,
      snapshot: () => ({
        sessionId: 'primary',
        state: { panelOpen: true, tabs: [], activeTabId: null },
      }),
      subscribe: listener => {
        listener()
        return () => undefined
      },
    })
    const attachSecondary = attachRightWorkspaceSidebarController({
      active: () => false,
      openTab: openSecondary,
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      updateTab: vi.fn(),
      snapshot: () => ({
        sessionId: 'secondary',
        state: { panelOpen: false, tabs: [], activeTabId: null },
      }),
      subscribe: () => () => undefined,
    })

    rightWorkspaceBetterSidebar.openTab({ type: 'test:primary' })
    rightWorkspaceBetterSidebar.openTab({ type: 'test:secondary' }, { sessionId: 'secondary' })
    rightWorkspaceBetterSidebar.updateTab('tab-1', { title: 'Updated' })

    expect(openPrimary).toHaveBeenCalledWith({ type: 'test:primary' }, undefined)
    expect(openSecondary).toHaveBeenCalledWith(
      { type: 'test:secondary' },
      { sessionId: 'secondary' }
    )
    expect(updatePrimary).toHaveBeenCalledWith('tab-1', { title: 'Updated' })
    expect(stateListener).toHaveBeenCalled()

    attachSecondary()
    attachPrimary()
    unsubscribeState()
  })

  test('uses an isolated internal id while preserving the plugin tab id', () => {
    expect(encodeRightWorkspaceExtensionTabId('dsh-sidebar-qa:ask')).toBe(
      'dsh:dsh-sidebar-qa%3Aask'
    )
  })

  test('passes the real DSH client context to contributed components', () => {
    const sessions = { marker: 'dsh-sessions' }
    window.__WEWORK_DSH_EXTENSIONS_BRIDGE__ = {
      context: {
        wework: window.__WEWORK_DSH_HOST__!,
        betterSidebar: rightWorkspaceBetterSidebar,
        sessions,
      },
      wework: window.__WEWORK_DSH_HOST__!,
      service: rightWorkspaceBetterSidebar,
      attachHost: vi.fn(),
    }

    expect(rightWorkspaceExtensionContext.wework).toBe(window.__WEWORK_DSH_HOST__)
    expect(rightWorkspaceExtensionContext.wework.extensions).toBe(window.__WEWORK_DSH_EXTENSIONS__)
    expect(rightWorkspaceExtensionContext.betterSidebar).toBe(rightWorkspaceBetterSidebar)
    expect(rightWorkspaceExtensionContext.sessions).toBe(sessions)

    delete window.__WEWORK_DSH_EXTENSIONS_BRIDGE__
  })
})
