import { describe, expect, test, vi } from 'vitest'
import {
  attachRightWorkspaceSidebarController,
  encodeRightWorkspaceExtensionTabId,
  isWeworkWorkspaceSidebarTabAvailable,
  rightWorkspaceDshSidebar,
  shouldCloseUnavailableWeworkWorkspaceSidebarTab,
} from './rightWorkspaceDshSidebar'

describe('rightWorkspaceDshSidebar', () => {
  test('reads and subscribes to native DSH sidebar slot entries', () => {
    const listener = vi.fn()
    const descriptor = {
      id: 'test:inspector',
      mode: 'iframe' as const,
      title: 'Inspector',
      order: 10,
      url: 'https://example.com/',
    }
    const subscribe = vi.fn(() => () => undefined)
    window.__WEWORK_DSH_UI__ = {
      getEntries: () => [{ ...descriptor, label: descriptor.title }],
      subscribe,
      attach: vi.fn(),
    }

    expect(rightWorkspaceDshSidebar.getTab(descriptor.id)).toEqual(descriptor)
    expect(rightWorkspaceDshSidebar.getTabs()).toContainEqual(descriptor)
    const unsubscribe = rightWorkspaceDshSidebar.subscribe(listener)
    expect(subscribe).toHaveBeenCalledWith('wework.workspace.sidebar.tab', listener)
    unsubscribe()
    delete window.__WEWORK_DSH_UI__
  })

  test('routes stateful operations to the active or explicitly targeted Wework pane', () => {
    const openPrimary = vi.fn()
    const openSecondary = vi.fn()
    const updatePrimary = vi.fn()
    const stateListener = vi.fn()
    const unsubscribeState = rightWorkspaceDshSidebar.subscribeState(stateListener)
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

    rightWorkspaceDshSidebar.openTab({ type: 'test:primary' })
    rightWorkspaceDshSidebar.openTab({ type: 'test:secondary' }, { sessionId: 'secondary' })
    rightWorkspaceDshSidebar.updateTab('tab-1', { title: 'Updated' })

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
    expect(encodeRightWorkspaceExtensionTabId('native-plugin:panel')).toBe(
      'dsh:native-plugin%3Apanel'
    )
  })

  test('filters conditional tabs from cached project context without filesystem access', () => {
    const descriptor = {
      id: 'plugin-debug',
      title: '插件调试',
      when: {
        projectKinds: ['wework-core-dsh-plugin'] as const,
      },
    }

    expect(isWeworkWorkspaceSidebarTabAvailable(descriptor, 'standard')).toBe(false)
    expect(isWeworkWorkspaceSidebarTabAvailable(descriptor, 'unresolved')).toBe(false)
    expect(isWeworkWorkspaceSidebarTabAvailable(descriptor, 'wework-core-dsh-plugin')).toBe(true)
    expect(shouldCloseUnavailableWeworkWorkspaceSidebarTab(descriptor, 'unresolved', false)).toBe(
      false
    )
    expect(shouldCloseUnavailableWeworkWorkspaceSidebarTab(descriptor, 'standard', false)).toBe(
      true
    )
  })

  test('preserves plugin-only conditions from DSH descriptors', () => {
    window.__WEWORK_DSH_UI__ = {
      getEntries: () => [
        {
          id: 'plugin-only',
          label: 'Plugin only',
          when: { codexPluginKeys: ['plugin-a'] },
        },
      ],
      subscribe: vi.fn(() => () => undefined),
      attach: vi.fn(),
    }

    expect(rightWorkspaceDshSidebar.getTab('plugin-only')?.when).toEqual({
      projectKinds: undefined,
      codexPluginKeys: ['plugin-a'],
    })
    delete window.__WEWORK_DSH_UI__
  })

  test('does not expose iframe tabs without a usable URL', () => {
    window.__WEWORK_DSH_UI__ = {
      getEntries: () => [
        {
          id: 'valid-iframe',
          label: 'Valid iframe',
          mode: 'iframe',
          url: ' https://example.com/ ',
        },
        { id: 'missing-url', label: 'Missing URL', mode: 'iframe' },
        { id: 'empty-url', label: 'Empty URL', mode: 'iframe', url: '   ' },
        { id: 'invalid-url', label: 'Invalid URL', mode: 'iframe', url: 42 },
        { id: 'component-tab', label: 'Component tab' },
      ],
      subscribe: vi.fn(() => () => undefined),
      attach: vi.fn(),
    }

    expect(rightWorkspaceDshSidebar.getTabs()).toEqual([
      {
        id: 'valid-iframe',
        title: 'Valid iframe',
        titleKey: undefined,
        mode: 'iframe',
        order: undefined,
        url: 'https://example.com/',
        when: undefined,
      },
      {
        id: 'component-tab',
        title: 'Component tab',
        titleKey: undefined,
        mode: undefined,
        order: undefined,
        url: undefined,
        when: undefined,
      },
    ])
    delete window.__WEWORK_DSH_UI__
  })

  test('does not expose the removed Better Sidebar compatibility globals', () => {
    expect(window).not.toHaveProperty('__WEWORK_DSH_HOST__')
    expect(window).not.toHaveProperty('__WEWORK_DSH_EXTENSIONS__')
    expect(window).not.toHaveProperty('__WEWORK_DSH_BETTER_SIDEBAR__')
  })
})
