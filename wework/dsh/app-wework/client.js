window.__ModuleLoader__.load({
  id: '@wegent/dsh-app-wework',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement, useCallback, useEffect, useMemo, useState } = React

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
                ? '功能将在后续迁移工作包中从现有 Tauri 前端逐步迁入此模块。'
                : `已恢复绑定：${activeTab.binding.route}`
            )
          )
        )
      )
    }

    const inject = ['slots', 'weworkDesktop']
    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'wework-app: styles')
      ctx.effect(
        () =>
          ctx.slots.register(
            {
              name: 'root',
              priority: ROOT_PRIORITY,
            },
            WeworkApp
          ),
        'wework-app: root registration'
      )
    }

    exports.FIXED_TABS = FIXED_TABS
    exports.MAX_DYNAMIC_TABS = MAX_DYNAMIC_TABS
    exports.STORAGE_KEY = STORAGE_KEY
    exports.activateTab = activateTab
    exports.apply = apply
    exports.claimThreadWrite = claimThreadWrite
    exports.closeDynamicTab = closeDynamicTab
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
