window.__ModuleLoader__.load({
  id: '@wegent/dsh-app-wework',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement, useCallback, useEffect, useMemo, useState } = React
    const { createRoot } = require('react-dom/client')

    const STORAGE_KEY = 'wegent.wework.workspace.v1'
    const STYLE_ID = '@wegent/dsh-app-wework/styles'
    const ROOT_PRIORITY = -100
    const MAX_DYNAMIC_TABS = 20
    const FIXED_TABS = Object.freeze([
      Object.freeze({
        id: 'wework:tasks',
        appKind: 'tasks',
        title: '任务',
        route: '/tasks',
        fixed: true,
      }),
      Object.freeze({
        id: 'wework:project-space',
        appKind: 'project-space',
        title: '项目空间',
        route: '/project-spaces',
        fixed: true,
      }),
      Object.freeze({
        id: 'wework:agents',
        appKind: 'agents',
        title: '智能体',
        route: '/agents',
        fixed: true,
      }),
    ])
    const FIXED_TAB_IDS = new Set(FIXED_TABS.map(tab => tab.id))
    const BETTER_SIDEBAR_VERSION = '0.15.2-wework.1'
    const WEWORK_HOST_VERSION = '1.0.0'
    const WEWORK_EXTENSIONS_VERSION = '1.0.0'
    const WEWORK_SIDEBAR_TAB_EXTENSION_POINT = 'wework.workspace.sidebar.tab'
    const BETTER_SIDEBAR_FEATURES = Object.freeze([
      'badge',
      'tabLifecycle',
      'updateTab',
      'targetedOpen',
      'stateSubscription',
      'tabMeta',
    ])

    class ExtensionRenderBoundary extends React.Component {
      state = { error: null }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }

      componentDidCatch(error, info) {
        console.error(
          '[Wework extensions] contributed surface render failed:',
          error,
          info.componentStack
        )
        this.props.onError?.(error, info.componentStack)
      }

      render() {
        if (this.state.error === null) return this.props.children
        return createElement(
          'div',
          {
            'data-wework-extension-render-error': '',
            style: {
              border: '1px solid color-mix(in srgb, #ef4444 45%, transparent)',
              borderRadius: '8px',
              color: '#ef4444',
              margin: '16px',
              padding: '12px',
              whiteSpace: 'pre-wrap',
            },
          },
          `Wework extension render failed: ${this.state.error}`
        )
      }
    }

    function createBetterSidebarBridge(context, hostWindow = window) {
      const tabs = new Map()
      const fileViewers = new Map()
      const listeners = new Set()
      const stateListeners = new Set()
      const hostTabDisposers = new Map()
      const betterSidebarDescriptors = new WeakSet()
      let extensionHost
      let sidebarHost
      let disposeHostState = () => {}
      let extensionSurfaceObserver
      let compatibilitySnapshot = Object.freeze({
        sessionId: undefined,
        state: undefined,
        prefs: Object.freeze({}),
      })
      const compatibilityStoreListeners = new Set()

      function publishCompatibilitySnapshot(nextSnapshot) {
        compatibilitySnapshot = Object.freeze(nextSnapshot)
        for (const listener of [...compatibilityStoreListeners]) listener()
      }

      function reduceCompatibilityState(reducer) {
        const state = compatibilitySnapshot.state
        if (!state) return
        publishCompatibilitySnapshot({
          ...compatibilitySnapshot,
          state: Object.freeze(reducer(state)),
        })
      }

      const betterSidebarPanelStore = Object.freeze({
        setActiveTab(scope, tab) {
          const rightPane = Object.freeze({
            kind: 'leaf',
            id: 'wework:right-sidebar',
            tabs: Object.freeze([tab]),
            active: tab.id,
          })
          publishCompatibilitySnapshot({
            sessionId: scope.sessionId || undefined,
            state: Object.freeze({
              panelOpen: true,
              width: 400,
              activePane: rightPane.id,
              nextTerminal: 1,
              nextBrowser: 1,
              expanded: Object.freeze([]),
              splits: rightPane,
              bottomOpen: true,
              bottomHeight: 220,
              bottomOpenedOnce: true,
              bottomSplits: Object.freeze({
                kind: 'leaf',
                id: 'wework:bottom-sidebar',
                tabs: Object.freeze([]),
                active: null,
              }),
            }),
            prefs: compatibilitySnapshot.prefs,
          })
        },
        subscribe(listener) {
          compatibilityStoreListeners.add(listener)
          return () => compatibilityStoreListeners.delete(listener)
        },
        getSnapshot: () => compatibilitySnapshot,
        update(mutator) {
          const state = compatibilitySnapshot.state
          if (!state) return
          const draft = structuredClone(state)
          mutator(draft)
          publishCompatibilitySnapshot({
            ...compatibilitySnapshot,
            state: Object.freeze(draft),
          })
        },
        reduce(reducer) {
          reduceCompatibilityState(reducer)
        },
        reduceFor(sessionId, reducer) {
          if (compatibilitySnapshot.sessionId !== sessionId) return
          reduceCompatibilityState(reducer)
        },
        tabOpen(sessionId, tabId) {
          if (compatibilitySnapshot.sessionId !== sessionId) return false
          return compatibilitySnapshot.state?.splits.tabs.some(tab => tab.id === tabId) ?? false
        },
      })

      function ensureExtensionSurface() {
        const existing = document.querySelector('[data-wework-dsh-extension-surface]')
        if (existing instanceof HTMLElement) return existing
        const surface = document.createElement('div')
        surface.setAttribute('data-wework-dsh-extension-surface', '')
        const concealRuntimeChrome = node => {
          if (
            node === surface ||
            !(node instanceof HTMLElement) ||
            ['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName)
          ) {
            return
          }
          node.style.display = 'none'
        }
        for (const child of [...document.body.children]) concealRuntimeChrome(child)
        extensionSurfaceObserver = new MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes) concealRuntimeChrome(node)
          }
        })
        extensionSurfaceObserver.observe(document.body, { childList: true })
        Object.assign(document.documentElement.style, {
          background: 'transparent',
          height: '100%',
          overflow: 'hidden',
        })
        Object.assign(document.body.style, {
          background: 'transparent',
          height: '100%',
          margin: '0',
          overflow: 'hidden',
        })
        Object.assign(surface.style, {
          height: '100%',
          overflow: 'hidden',
          width: '100%',
        })
        document.body.append(surface)
        return surface
      }

      function descriptorForHost(descriptor) {
        if (typeof descriptor.component !== 'function') return descriptor
        return {
          ...descriptor,
          // React elements from a DSH plugin belong to DSH's React runtime. Wework
          // asks that runtime to mount into its DOM host instead of rendering the
          // foreign element with Wework's React instance.
          icon: undefined,
          component: undefined,
          mount(container, props) {
            const surface = ensureExtensionSurface()
            surface.replaceChildren()
            const betterSidebarCompatible = betterSidebarDescriptors.has(descriptor)
            const reportRenderError = error => {
              const message = error instanceof Error ? error.message : String(error)
              container.dataset.weworkExtensionMountState = 'failed'
              container.dataset.weworkExtensionMountError = message
              container.dataset.weworkExtensionMountStack =
                error instanceof Error ? error.stack || '' : ''
              console.error(
                `[Wework extensions] failed to render sidebar tab "${descriptor.id}":`,
                error
              )
            }
            container.dataset.weworkExtensionMountState = 'rendering'
            hostWindow.__WEWORK_DSH_EXTENSION_FRAME_HOST__?.show(container)
            const root = createRoot(surface, {
              onCaughtError: reportRenderError,
              onRecoverableError: reportRenderError,
              onUncaughtError: reportRenderError,
            })
            const render = nextProps => {
              if (betterSidebarCompatible) {
                betterSidebarPanelStore.setActiveTab(nextProps.scope, nextProps.tab)
              }
              root.render(
                createElement(
                  ExtensionRenderBoundary,
                  { onError: reportRenderError },
                  createElement(descriptor.component, {
                    ...nextProps,
                    ctx: context,
                    ...(betterSidebarCompatible ? { store: betterSidebarPanelStore } : {}),
                  })
                )
              )
              queueMicrotask(() => {
                if (container.dataset.weworkExtensionMountState !== 'failed') {
                  container.dataset.weworkExtensionMountState =
                    surface.childNodes.length > 0 ? 'mounted' : 'empty'
                }
              })
            }
            render(props)
            return {
              update: render,
              dispose() {
                root.unmount()
                surface.replaceChildren()
                hostWindow.__WEWORK_DSH_EXTENSION_FRAME_HOST__?.hide(container)
              },
            }
          },
        }
      }

      function notifyRegistry() {
        for (const listener of [...listeners]) listener()
      }

      function notifyState() {
        for (const listener of [...stateListeners]) listener()
      }

      function registerTabWithHost(descriptor) {
        if (!extensionHost) return
        hostTabDisposers.set(
          descriptor.id,
          extensionHost.register(WEWORK_SIDEBAR_TAB_EXTENSION_POINT, descriptorForHost(descriptor))
        )
      }

      function detachHost() {
        disposeHostState()
        disposeHostState = () => {}
        for (const dispose of hostTabDisposers.values()) dispose()
        hostTabDisposers.clear()
        extensionHost = undefined
        sidebarHost = undefined
      }

      function registerSidebarTab(descriptor, betterSidebarCompatible = false) {
        if (!descriptor?.id?.trim()) {
          throw new Error('[Wework extensions] sidebar tab id is required')
        }
        if (tabs.has(descriptor.id)) {
          throw new Error(`[Wework extensions] sidebar tab "${descriptor.id}" already registered`)
        }
        if (betterSidebarCompatible) betterSidebarDescriptors.add(descriptor)
        tabs.set(descriptor.id, descriptor)
        registerTabWithHost(descriptor)
        notifyRegistry()
        return () => {
          if (tabs.get(descriptor.id) !== descriptor) return
          hostTabDisposers.get(descriptor.id)?.()
          hostTabDisposers.delete(descriptor.id)
          tabs.delete(descriptor.id)
          notifyRegistry()
        }
      }

      const extensions = Object.freeze({
        protocol: 'wework.extensions.v1',
        version: WEWORK_EXTENSIONS_VERSION,
        extensionPoints: Object.freeze([WEWORK_SIDEBAR_TAB_EXTENSION_POINT]),
        register(extensionPoint, contribution) {
          if (extensionPoint !== WEWORK_SIDEBAR_TAB_EXTENSION_POINT) {
            throw new Error(`[Wework extensions] unsupported extension point "${extensionPoint}"`)
          }
          return registerSidebarTab(contribution)
        },
      })
      const wework = Object.freeze({
        protocol: 'wework.host.v1',
        version: WEWORK_HOST_VERSION,
        extensions,
      })

      const service = Object.freeze({
        version: BETTER_SIDEBAR_VERSION,
        features: BETTER_SIDEBAR_FEATURES,
        registerTab: descriptor => registerSidebarTab(descriptor, true),
        registerFileViewer(descriptor) {
          if (!descriptor?.id?.trim()) {
            throw new Error('[Wework better-sidebar] file viewer id is required')
          }
          if (fileViewers.has(descriptor.id)) {
            throw new Error(
              `[Wework better-sidebar] file viewer "${descriptor.id}" already registered`
            )
          }
          fileViewers.set(descriptor.id, descriptor)
          notifyRegistry()
          return () => {
            if (fileViewers.get(descriptor.id) !== descriptor) return
            fileViewers.delete(descriptor.id)
            notifyRegistry()
          }
        },
        getTabs: () => [...tabs.values()],
        getFileViewers: () => [...fileViewers.values()],
        getTab: id => tabs.get(id),
        isTabEnabled: id => tabs.has(id),
        isViewerEnabled: id => fileViewers.has(id),
        matchFileViewer(path, head) {
          const extension = String(path).split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || ''
          return [...fileViewers.values()]
            .sort((left, right) => (right.priority || 0) - (left.priority || 0))
            .find(viewer => {
              try {
                if (head && viewer.detect?.(head, path)) return true
              } catch (error) {
                console.error('[Wework better-sidebar] file viewer detection failed:', error)
              }
              return (
                Array.isArray(viewer.exts) &&
                (viewer.exts.length === 0 ||
                  viewer.exts.some(candidate => String(candidate).toLowerCase() === extension))
              )
            })
        },
        openTab: (seed, scope) => sidebarHost?.openTab(seed, scope),
        closeTab: (tabId, scope) => sidebarHost?.closeTab(tabId, scope),
        activateTab: (tabId, scope) => sidebarHost?.activateTab(tabId, scope),
        updateTab: (tabId, patch) => sidebarHost?.updateTab(tabId, patch),
        openFile(scope, path, title) {
          const viewer = service.matchFileViewer(path)
          sidebarHost?.openTab(
            {
              type: viewer ? 'editor' : 'editor',
              path,
              title: title || String(path).split(/[\\/]/).pop() || path,
            },
            scope
          )
        },
        getSnapshot: () => sidebarHost?.getSnapshot() || {},
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        subscribeState(listener) {
          stateListeners.add(listener)
          return () => stateListeners.delete(listener)
        },
      })
      return {
        context,
        service,
        wework,
        attachHost(nextExtensionHost, nextSidebarHost) {
          if (extensionHost === nextExtensionHost && sidebarHost === nextSidebarHost) return
          detachHost()
          extensionHost = nextExtensionHost
          sidebarHost = nextSidebarHost
          for (const descriptor of tabs.values()) registerTabWithHost(descriptor)
          disposeHostState = sidebarHost?.subscribeState?.(notifyState) || (() => {})
          notifyRegistry()
          notifyState()
        },
        dispose() {
          detachHost()
          extensionSurfaceObserver?.disconnect()
          extensionSurfaceObserver = undefined
          tabs.clear()
          fileViewers.clear()
          listeners.clear()
          stateListeners.clear()
        },
      }
    }

    function defaultState() {
      return {
        version: 1,
        activeTabId: FIXED_TABS[0].id,
        dynamicTabs: [],
        threadLeases: {},
      }
    }

    function isRecord(value) {
      return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    }

    function optionalString(value) {
      return typeof value === 'string' && value.length > 0 ? value : undefined
    }

    function parseBinding(value) {
      if (!isRecord(value) || value.version !== 1) return null
      if (
        typeof value.tabId !== 'string' ||
        value.appKind !== 'smart-app' ||
        typeof value.route !== 'string' ||
        typeof value.lastOpenedAt !== 'string'
      ) {
        return null
      }
      const date = Date.parse(value.lastOpenedAt)
      if (!Number.isFinite(date)) return null
      return {
        version: 1,
        tabId: value.tabId,
        appKind: 'smart-app',
        route: value.route,
        lastOpenedAt: new Date(date).toISOString(),
        ...(optionalString(value.projectId) ? { projectId: value.projectId } : {}),
        ...(optionalString(value.taskId) ? { taskId: value.taskId } : {}),
        ...(optionalString(value.executionId) ? { executionId: value.executionId } : {}),
        ...(optionalString(value.workspaceId) ? { workspaceId: value.workspaceId } : {}),
        ...(optionalString(value.codexThreadId) ? { codexThreadId: value.codexThreadId } : {}),
        ...(optionalString(value.dshSessionId) ? { dshSessionId: value.dshSessionId } : {}),
      }
    }

    function parseDynamicTab(value) {
      if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        FIXED_TAB_IDS.has(value.id) ||
        typeof value.title !== 'string' ||
        value.title.length === 0
      ) {
        return null
      }
      const binding = parseBinding(value.binding)
      if (!binding || binding.tabId !== value.id) return null
      return {
        id: value.id,
        title: value.title,
        fixed: false,
        appKind: 'smart-app',
        route: binding.route,
        binding,
      }
    }

    function restoreState(storage) {
      let value
      try {
        value = JSON.parse(storage.getItem(STORAGE_KEY) || 'null')
      } catch {
        return defaultState()
      }
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.dynamicTabs)) {
        return defaultState()
      }
      const ids = new Set()
      const dynamicTabs = []
      for (const candidate of value.dynamicTabs) {
        const tab = parseDynamicTab(candidate)
        if (!tab || ids.has(tab.id)) continue
        ids.add(tab.id)
        dynamicTabs.push(tab)
        if (dynamicTabs.length === MAX_DYNAMIC_TABS) break
      }
      const knownIds = new Set([...FIXED_TAB_IDS, ...dynamicTabs.map(tab => tab.id)])
      const threadLeases = {}
      if (isRecord(value.threadLeases)) {
        for (const [threadId, tabId] of Object.entries(value.threadLeases)) {
          if (typeof tabId !== 'string') continue
          const tab = dynamicTabs.find(candidate => candidate.id === tabId)
          if (tab?.binding.codexThreadId === threadId) threadLeases[threadId] = tabId
        }
      }
      return {
        version: 1,
        activeTabId:
          typeof value.activeTabId === 'string' && knownIds.has(value.activeTabId)
            ? value.activeTabId
            : FIXED_TABS[0].id,
        dynamicTabs,
        threadLeases,
      }
    }

    function persistState(storage, state) {
      storage.setItem(STORAGE_KEY, JSON.stringify(state))
    }

    function activateTab(state, tabId, now = new Date()) {
      if (FIXED_TAB_IDS.has(tabId)) return { ...state, activeTabId: tabId }
      let found = false
      const dynamicTabs = state.dynamicTabs.map(tab => {
        if (tab.id !== tabId) return tab
        found = true
        const binding = { ...tab.binding, lastOpenedAt: now.toISOString() }
        return { ...tab, binding }
      })
      return found ? { ...state, activeTabId: tabId, dynamicTabs } : state
    }

    function openSmartApp(state, input, now = new Date()) {
      if (!isRecord(input) || typeof input.appId !== 'string' || input.appId.length === 0) {
        throw new Error('appId is required')
      }
      const tabId = `smart-app:${input.appId}`
      const existing = state.dynamicTabs.find(tab => tab.id === tabId)
      if (existing) return activateTab(state, tabId, now)
      if (state.dynamicTabs.length >= MAX_DYNAMIC_TABS) {
        throw new Error(`At most ${MAX_DYNAMIC_TABS} dynamic tabs may be open`)
      }
      const route =
        typeof input.route === 'string' && input.route.length > 0
          ? input.route
          : `/smart-apps/${encodeURIComponent(input.appId)}`
      const binding = {
        version: 1,
        tabId,
        appKind: 'smart-app',
        route,
        lastOpenedAt: now.toISOString(),
        ...(optionalString(input.projectId) ? { projectId: input.projectId } : {}),
        ...(optionalString(input.taskId) ? { taskId: input.taskId } : {}),
        ...(optionalString(input.executionId) ? { executionId: input.executionId } : {}),
        ...(optionalString(input.workspaceId) ? { workspaceId: input.workspaceId } : {}),
        ...(optionalString(input.codexThreadId) ? { codexThreadId: input.codexThreadId } : {}),
        ...(optionalString(input.dshSessionId) ? { dshSessionId: input.dshSessionId } : {}),
      }
      const tab = {
        id: tabId,
        title:
          typeof input.title === 'string' && input.title.length > 0 ? input.title : input.appId,
        fixed: false,
        appKind: 'smart-app',
        route,
        binding,
      }
      return {
        ...state,
        activeTabId: tabId,
        dynamicTabs: [...state.dynamicTabs, tab],
      }
    }

    function closeDynamicTab(state, tabId) {
      if (FIXED_TAB_IDS.has(tabId)) return state
      const index = state.dynamicTabs.findIndex(tab => tab.id === tabId)
      if (index < 0) return state
      const dynamicTabs = state.dynamicTabs.filter(tab => tab.id !== tabId)
      const threadLeases = Object.fromEntries(
        Object.entries(state.threadLeases).filter(([, ownerTabId]) => ownerTabId !== tabId)
      )
      if (state.activeTabId !== tabId) return { ...state, dynamicTabs, threadLeases }
      const next = dynamicTabs[Math.min(index, Math.max(0, dynamicTabs.length - 1))]
      return {
        ...state,
        activeTabId: next?.id || FIXED_TABS[0].id,
        dynamicTabs,
        threadLeases,
      }
    }

    function claimThreadWrite(state, tabId) {
      const tab = state.dynamicTabs.find(candidate => candidate.id === tabId)
      const threadId = tab?.binding.codexThreadId
      if (!threadId) {
        return { state, writable: false, ownerTabId: null, reason: 'thread_unbound' }
      }
      const ownerTabId = state.threadLeases[threadId]
      if (ownerTabId && ownerTabId !== tabId) {
        return { state, writable: false, ownerTabId, reason: 'thread_write_leased' }
      }
      return {
        state: {
          ...state,
          threadLeases: {
            ...state.threadLeases,
            [threadId]: tabId,
          },
        },
        writable: true,
        ownerTabId: tabId,
      }
    }

    function removeSmartApp(state, appId) {
      return closeDynamicTab(state, `smart-app:${appId}`)
    }

    function tabsOf(state) {
      return [...FIXED_TABS, ...state.dynamicTabs]
    }

    function injectStyles() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
      const style = document.createElement('style')
      style.dataset.plugin = '@wegent/dsh-app-wework'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = `
        :root {
          --wework-bg: var(--dsw-alias-bg-base, #fff);
          --wework-sidebar: var(--dsw-specific-sidebar-fill, #f7f7f7);
          --wework-text: var(--dsw-alias-fg-primary, #18181b);
          --wework-muted: var(--dsw-alias-fg-secondary, #71717a);
          --wework-border: var(--dsw-alias-border-l1, rgb(24 24 27 / 8%));
          --wework-selected: var(--dsw-alias-bg-layer-2, #ededed);
        }
        * { box-sizing: border-box; }
        .wework-app {
          display: grid;
          grid-template-columns: 264px minmax(0, 1fr);
          width: 100%;
          height: 100%;
          color: var(--wework-text);
          background: var(--wework-bg);
          font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: hidden;
        }
        .wework-sidebar {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 16px;
          padding: 16px 12px;
          border-right: 1px solid var(--wework-border);
          background: var(--wework-sidebar);
        }
        .wework-brand { padding: 4px 10px; font-weight: 500; }
        .wework-tabs { display: flex; flex: 1; flex-direction: column; gap: 4px; }
        .wework-tab {
          display: flex;
          min-width: 0;
          height: 30px;
          align-items: center;
          gap: 8px;
          padding: 0 10px;
          border: 0;
          border-radius: 10px;
          color: inherit;
          background: transparent;
          cursor: pointer;
          text-align: left;
        }
        .wework-tab:hover { background: color-mix(in srgb, var(--wework-selected), transparent 35%); }
        .wework-tab[aria-selected="true"] { background: var(--wework-selected); }
        .wework-tab-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .wework-close {
          width: 24px;
          height: 24px;
          padding: 0;
          border: 0;
          border-radius: 6px;
          color: var(--wework-muted);
          background: transparent;
          cursor: pointer;
        }
        .wework-close:hover { color: var(--wework-text); background: var(--wework-bg); }
        .wework-workbench {
          height: 30px;
          padding: 0 10px;
          border: 1px solid var(--wework-border);
          border-radius: 8px;
          color: inherit;
          background: var(--wework-bg);
          cursor: pointer;
          text-align: left;
        }
        .wework-main { min-width: 0; overflow: auto; }
        .wework-surface { max-width: 960px; margin: 0 auto; padding: 40px 32px; }
        .wework-surface h1 { margin: 0 0 8px; font-size: 24px; line-height: 29px; font-weight: 500; }
        .wework-surface p { margin: 0; color: var(--wework-muted); }
        .wework-placeholder {
          margin-top: 32px;
          padding: 20px;
          border: 1px solid var(--wework-border);
          border-radius: 16px;
          background: var(--wework-bg);
        }
      `
      document.head.appendChild(style)
      return () => style.remove()
    }

    function titleFor(tab) {
      if (tab.appKind === 'tasks') return ['任务', '管理任务、对话、执行、审批和结果。']
      if (tab.appKind === 'project-space') {
        return ['项目空间', '管理项目看板、任务详情、评论、附件、交付和工作流。']
      }
      if (tab.appKind === 'agents') {
        return ['智能体', '管理智能体、机器人、模型、技能和 MCP。']
      }
      return [tab.title, '此动态 Tab 由当前 Wework DSH runtime 承载。']
    }

    function WeworkApp() {
      const [state, setState] = useState(() => restoreState(window.localStorage))
      const tabs = useMemo(() => tabsOf(state), [state])
      const activeTab = tabs.find(tab => tab.id === state.activeTabId) || FIXED_TABS[0]
      const [title, description] = titleFor(activeTab)

      useEffect(() => {
        persistState(window.localStorage, state)
      }, [state])

      const selectTab = useCallback(tabId => {
        setState(current => activateTab(current, tabId))
      }, [])
      const closeTab = useCallback((event, tabId) => {
        event.stopPropagation()
        setState(current => closeDynamicTab(current, tabId))
      }, [])
      const openWorkbench = useCallback(() => {
        setState(current =>
          openSmartApp(current, {
            appId: 'workbench',
            title: '智能工作台',
            route: '/smart-workbench',
          })
        )
      }, [])

      return createElement(
        'div',
        { className: 'wework-app', 'data-testid': 'wework-dsh-app' },
        createElement(
          'aside',
          { className: 'wework-sidebar' },
          createElement('div', { className: 'wework-brand' }, 'Wework'),
          createElement(
            'nav',
            { className: 'wework-tabs', role: 'tablist', 'aria-label': '工作台' },
            ...tabs.map(tab =>
              createElement(
                'button',
                {
                  key: tab.id,
                  type: 'button',
                  className: 'wework-tab',
                  role: 'tab',
                  'aria-selected': tab.id === activeTab.id ? 'true' : 'false',
                  'data-testid': `wework-tab-${tab.id}`,
                  onClick: () => selectTab(tab.id),
                },
                createElement('span', { className: 'wework-tab-label' }, tab.title),
                !tab.fixed &&
                  createElement(
                    'span',
                    {
                      role: 'button',
                      tabIndex: 0,
                      className: 'wework-close',
                      'aria-label': `关闭 ${tab.title}`,
                      'data-testid': `wework-close-${tab.id}`,
                      onClick: event => closeTab(event, tab.id),
                      onKeyDown: event => {
                        if (event.key === 'Enter' || event.key === ' ') closeTab(event, tab.id)
                      },
                    },
                    '×'
                  )
              )
            )
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'wework-workbench',
              'data-testid': 'wework-open-smart-workbench',
              onClick: openWorkbench,
            },
            '智能工作台'
          )
        ),
        createElement(
          'main',
          { className: 'wework-main', 'data-testid': `wework-surface-${activeTab.appKind}` },
          createElement(
            'section',
            { className: 'wework-surface' },
            createElement('h1', null, title),
            createElement('p', null, description),
            createElement(
              'div',
              { className: 'wework-placeholder' },
              activeTab.fixed
                ? '功能将在后续工作包中逐步迁入此模块。'
                : `已恢复绑定：${activeTab.binding.route}`
            )
          )
        )
      )
    }

    const inject = ['weworkDesktop', 'sessions', 'connection', 'workspaces']

    function resolveWeworkHostWindow() {
      try {
        if (
          window.parent &&
          window.parent !== window &&
          (window.parent.__WEWORK_DSH_EXTENSIONS__ || window.parent.__WEWORK_DSH_BETTER_SIDEBAR__)
        ) {
          return window.parent
        }
      } catch {
        // Cross-origin parents are not Wework extension hosts.
      }
      return window
    }

    function apply(ctx) {
      const hostWindow = resolveWeworkHostWindow()
      const bridge = createBetterSidebarBridge(ctx, hostWindow)
      window.__WEWORK_DSH_EXTENSIONS_BRIDGE__ = bridge
      window.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__ = bridge
      hostWindow.__WEWORK_DSH_EXTENSIONS_BRIDGE__ = bridge
      hostWindow.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__ = bridge
      if (hostWindow.__WEWORK_DSH_EXTENSIONS__) {
        bridge.attachHost(
          hostWindow.__WEWORK_DSH_EXTENSIONS__,
          hostWindow.__WEWORK_DSH_BETTER_SIDEBAR__
        )
      }
      ctx.provide('wework', bridge.wework)
      ctx.provide('betterSidebar', bridge.service)
      ctx.effect(
        () => () => {
          bridge.dispose()
          if (window.__WEWORK_DSH_EXTENSIONS_BRIDGE__ === bridge) {
            delete window.__WEWORK_DSH_EXTENSIONS_BRIDGE__
          }
          if (window.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__ === bridge) {
            delete window.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__
          }
          if (hostWindow.__WEWORK_DSH_EXTENSIONS_BRIDGE__ === bridge) {
            delete hostWindow.__WEWORK_DSH_EXTENSIONS_BRIDGE__
          }
          if (hostWindow.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__ === bridge) {
            delete hostWindow.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__
          }
        },
        'wework-app: extension bridge cleanup'
      )
      ctx.effect(() => injectStyles(), 'wework-app: styles')
    }

    exports.FIXED_TABS = FIXED_TABS
    exports.MAX_DYNAMIC_TABS = MAX_DYNAMIC_TABS
    exports.STORAGE_KEY = STORAGE_KEY
    exports.activateTab = activateTab
    exports.apply = apply
    exports.claimThreadWrite = claimThreadWrite
    exports.closeDynamicTab = closeDynamicTab
    exports.createBetterSidebarBridge = createBetterSidebarBridge
    exports.defaultState = defaultState
    exports.inject = inject
    exports.openSmartApp = openSmartApp
    exports.parseBinding = parseBinding
    exports.persistState = persistState
    exports.removeSmartApp = removeSmartApp
    exports.restoreState = restoreState
    exports.tabsOf = tabsOf
    return module.exports
  },
})
