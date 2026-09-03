window.__ModuleLoader__.load({
  id: '@wegent/dsh-wework-plugin-developer',
  factory: require => {
    const React = require('react')
    const { createElement, useCallback, useEffect, useState } = React

    async function invoke(capability, params = {}) {
      const response = await fetch('/wework/electron-host/v1/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability, params }),
      })
      const body = await response.json()
      if (!response.ok || body.ok !== true) {
        throw new Error(body.error?.message || `Electron host request failed (${response.status})`)
      }
      return body.result
    }

    function CreatePluginAction({ onCreate, t }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      return createElement(
        React.Fragment,
        null,
        createElement(
          'button',
          {
            type: 'button',
            disabled: busy || !onCreate,
            'data-testid': 'wework-plugin-developer-create-button',
            className:
              'inline-flex min-h-9 items-center justify-center rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50',
            onClick: async () => {
              if (!onCreate || busy) return
              setBusy(true)
              setError('')
              try {
                await onCreate()
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason))
              } finally {
                setBusy(false)
              }
            },
          },
          busy
            ? t('workbench.plugin_development_creating', 'Creating…')
            : t('workbench.plugin_development_create', 'Create plugin')
        ),
        error
          ? createElement(
              'span',
              {
                'data-testid': 'wework-plugin-developer-create-error',
                className: 'ml-2 text-xs text-destructive',
              },
              error
            )
          : null
      )
    }

    function compactPath(path) {
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
    }

    function compactIdentifier(value) {
      if (!value) return '—'
      return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
    }

    function relativeTimestamp(timestamp, t) {
      if (!timestamp) return t('workbench.plugin_development_not_available', 'Not available')
      const elapsed = Date.now() - new Date(timestamp).getTime()
      if (!Number.isFinite(elapsed) || elapsed < 60_000) {
        return t('workbench.plugin_development_just_now', 'Just now')
      }
      const minutes = Math.max(1, Math.floor(elapsed / 60_000))
      return t('workbench.plugin_development_minutes_ago', '{{count}} min ago').replace(
        '{{count}}',
        String(minutes)
      )
    }

    function statusPresentation(status, t) {
      if (status === 'ready') {
        return {
          label: t('workbench.plugin_development_status_ready', 'Running'),
          dotClassName: 'bg-success',
        }
      }
      if (status === 'error') {
        return {
          label: t('workbench.plugin_development_status_error', 'Failed'),
          dotClassName: 'bg-destructive',
        }
      }
      if (['validating', 'starting', 'reloading', 'stopping'].includes(status)) {
        return {
          label: t('workbench.plugin_development_status_working', 'Working'),
          dotClassName: 'bg-warning',
        }
      }
      return {
        label: t('workbench.plugin_development_status_stopped', 'Not running'),
        dotClassName: 'bg-text-tertiary',
      }
    }

    function actionButton({
      children,
      className = '',
      disabled,
      onClick,
      testId,
      ariaExpanded,
      ariaHaspopup,
    }) {
      return createElement(
        'button',
        {
          type: 'button',
          disabled,
          'data-testid': testId,
          'aria-expanded': ariaExpanded,
          'aria-haspopup': ariaHaspopup,
          className: `inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-wait disabled:opacity-40 ${className}`,
          onClick,
        },
        children
      )
    }

    function sectionButton({ children, collapsedLabel, expanded, expandedLabel, onClick, testId }) {
      return actionButton({
        children: createElement(
          React.Fragment,
          null,
          createElement('span', { className: 'min-w-0 flex-1 truncate text-left' }, children),
          createElement(
            'span',
            { className: 'ml-3 shrink-0 text-xs font-normal text-text-tertiary' },
            expanded ? expandedLabel : collapsedLabel
          )
        ),
        ariaExpanded: expanded,
        className: 'w-full justify-between rounded-none px-3 text-text-primary hover:bg-muted/50',
        onClick,
        testId,
      })
    }

    function targetCell(label, primary, secondary, className = '') {
      return createElement(
        'div',
        { className: `min-w-0 px-3 py-3 ${className}` },
        createElement('p', { className: 'text-xs text-text-tertiary' }, label),
        createElement('p', { className: 'mt-1 truncate text-sm font-medium' }, primary),
        secondary
          ? createElement(
              'p',
              { className: 'mt-1 truncate font-mono text-xs text-text-tertiary' },
              secondary
            )
          : null
      )
    }

    function lifecycleStep(label, complete) {
      return createElement(
        'div',
        { className: 'flex min-w-0 items-center gap-2' },
        createElement('span', {
          'aria-hidden': 'true',
          className: `h-1.5 w-1.5 shrink-0 rounded-full ${
            complete ? 'bg-text-primary' : 'bg-border'
          }`,
        }),
        createElement(
          'span',
          {
            className: `truncate text-xs ${
              complete ? 'text-text-secondary' : 'text-text-tertiary'
            }`,
          },
          label
        )
      )
    }

    function eventFilterButton({ active, children, onClick, testId }) {
      return actionButton({
        children,
        className: active
          ? 'bg-muted text-text-primary'
          : 'text-text-tertiary hover:bg-muted/50 hover:text-text-primary',
        onClick,
        testId,
      })
    }

    function eventRow(event) {
      return createElement(
        'div',
        {
          key: event.testId,
          className:
            'grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border/50 px-3 py-2 first:border-t-0',
          'data-testid': event.testId,
        },
        createElement(
          'div',
          { className: 'flex min-w-0 items-start gap-2' },
          createElement('span', {
            'aria-hidden': 'true',
            className: `mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${event.dotClassName}`,
          }),
          createElement(
            'div',
            { className: 'min-w-0' },
            createElement(
              'p',
              {
                className: `truncate text-sm ${
                  event.type === 'error' ? 'text-destructive' : 'text-text-primary'
                }`,
              },
              event.label
            ),
            event.detail
              ? createElement(
                  'p',
                  { className: 'mt-0.5 truncate text-xs text-text-tertiary' },
                  event.detail
                )
              : null
          )
        ),
        createElement('span', { className: 'shrink-0 text-xs text-text-tertiary' }, event.timestamp)
      )
    }

    function PluginDebugPanel({ scope, t, visible }) {
      const [session, setSession] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
      const [eventFilter, setEventFilter] = useState('all')
      const [moreOpen, setMoreOpen] = useState(false)
      const [stopConfirmationOpen, setStopConfirmationOpen] = useState(false)
      const sourceRoot = scope?.cwd || ''

      const refresh = useCallback(async () => {
        try {
          const sessions = await invoke('pluginDevelopment.list')
          setSession(sessions.find(candidate => candidate.sourceRoot === sourceRoot) || null)
          setError('')
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }, [sourceRoot])

      useEffect(() => {
        if (!visible) return
        let active = true
        let cursor = 0
        let timer = 0

        const pollEvents = async () => {
          try {
            const batch = await invoke('desktop.events', { after: cursor })
            if (!active) return
            cursor = batch.latestSequence
            if (batch.historyLost) {
              await refresh()
            } else {
              for (const event of batch.events) {
                if (
                  event.type === 'plugin-development.state' &&
                  event.payload?.sourceRoot === sourceRoot
                ) {
                  setSession(event.payload)
                  setError('')
                }
              }
            }
          } catch (reason) {
            if (active) setError(reason instanceof Error ? reason.message : String(reason))
          }
          if (active) timer = window.setTimeout(pollEvents, 500)
        }

        void refresh().then(pollEvents)
        return () => {
          active = false
          window.clearTimeout(timer)
        }
      }, [refresh, visible])

      const run = useCallback(
        async (name, capability, params = {}) => {
          setBusy(name)
          setError('')
          try {
            await invoke(capability, params)
            await refresh()
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
          } finally {
            setBusy('')
          }
        },
        [refresh]
      )

      if (!visible) return null
      const currentSession = session
      const running = currentSession && !['stopped', 'error'].includes(currentSession.status)
      const status = currentSession?.status || 'stopped'
      const statusView = statusPresentation(status, t)
      const displayName =
        currentSession?.displayName || sourceRoot.split(/[\\/]/).filter(Boolean).at(-1) || ''
      const statusText = `${statusView.label} · HMR ${currentSession?.hmrGeneration || 0}`
      const hmrGeneration = currentSession?.hmrGeneration || 0
      const coreConnected = Boolean(currentSession?.coreDshPid)
      const pluginLoaded = status === 'ready' || status === 'reloading'
      const hmrConnected = pluginLoaded
      const events = [
        ...(currentSession
          ? [
              {
                type: 'runtime',
                label: t(
                  'workbench.plugin_development_event_instance_started',
                  'Debug instance started'
                ),
                detail: `${t('workbench.plugin_development_instance_id', 'Instance ID')} ${compactIdentifier(currentSession.id)}`,
                timestamp: relativeTimestamp(currentSession.startedAt, t),
                dotClassName: 'bg-text-secondary',
                testId: 'wework-plugin-development-event-instance',
              },
            ]
          : []),
        ...(coreConnected
          ? [
              {
                type: 'runtime',
                label: t('workbench.plugin_development_event_core_connected', 'Core DSH connected'),
                detail: `${t('workbench.plugin_development_process_id', 'Process ID')} ${currentSession.coreDshPid}`,
                timestamp: relativeTimestamp(currentSession.updatedAt, t),
                dotClassName: 'bg-success',
                testId: 'wework-plugin-development-event-core-dsh',
              },
            ]
          : []),
        ...(hmrGeneration > 0
          ? [
              {
                type: 'hmr',
                label: t('workbench.plugin_development_event_hmr_accepted', 'HMR update accepted'),
                detail: `${t(
                  'workbench.plugin_development_hmr_generation',
                  'HMR generation'
                )} ${hmrGeneration}`,
                timestamp: relativeTimestamp(currentSession.hmrUpdatedAt, t),
                dotClassName: 'bg-success',
                testId: 'wework-plugin-development-event-hmr',
              },
            ]
          : []),
        ...(currentSession?.lastError
          ? [
              {
                type: 'error',
                label: t('workbench.plugin_development_event_error', 'Runtime error'),
                detail: `${currentSession.lastError.stage}: ${currentSession.lastError.message}`,
                timestamp: relativeTimestamp(currentSession.lastError.timestamp, t),
                dotClassName: 'bg-destructive',
                testId: 'wework-plugin-development-event-error',
              },
            ]
          : []),
      ]
      const filteredEvents =
        eventFilter === 'all' ? events : events.filter(event => event.type === eventFilter)
      const stableRunning = status === 'ready'
      return createElement(
        'aside',
        {
          'data-testid': 'wework-plugin-development-sidebar',
          className: 'h-full min-h-0 overflow-auto p-5 text-text-primary',
        },
        createElement(
          'header',
          { className: 'relative flex w-full max-w-3xl items-start justify-between gap-4' },
          createElement(
            'div',
            { className: 'min-w-0' },
            createElement(
              'h2',
              { className: 'text-lg font-medium' },
              t('workbench.plugin_development_debug', 'Plugin debugging')
            ),
            createElement('p', { className: 'mt-1 truncate text-sm' }, displayName),
            createElement(
              'div',
              { className: 'mt-1 flex min-w-0 items-center gap-2' },
              createElement('span', {
                'aria-hidden': 'true',
                className: `h-1.5 w-1.5 shrink-0 rounded-full ${statusView.dotClassName}`,
              }),
              createElement(
                'span',
                {
                  'data-testid': 'wework-plugin-development-sidebar-status',
                  className: 'truncate text-xs text-text-secondary',
                  role: 'status',
                },
                statusText
              ),
              busy
                ? createElement(
                    'span',
                    { className: 'shrink-0 text-xs text-text-tertiary' },
                    t('workbench.plugin_development_updating', 'Updating…')
                  )
                : null
            )
          ),
          running
            ? createElement(
                'div',
                {
                  className: 'relative shrink-0',
                },
                actionButton({
                  children: t('workbench.plugin_development_more', 'More'),
                  ariaExpanded: moreOpen,
                  ariaHaspopup: 'menu',
                  className: 'px-2 text-text-secondary hover:bg-muted hover:text-text-primary',
                  onClick: () => {
                    setMoreOpen(value => !value)
                    setStopConfirmationOpen(false)
                  },
                  testId: 'wework-plugin-development-sidebar-more',
                }),
                moreOpen
                  ? createElement(
                      'div',
                      {
                        className:
                          'absolute right-0 top-10 z-popover w-56 rounded-xl border border-border/70 bg-popover p-1 shadow-lg',
                        role: 'menu',
                        'data-testid': 'wework-plugin-development-sidebar-more-menu',
                      },
                      stopConfirmationOpen
                        ? createElement(
                            React.Fragment,
                            null,
                            createElement(
                              'p',
                              { className: 'px-2 py-2 text-xs text-text-secondary' },
                              t(
                                'workbench.plugin_development_stop_confirmation',
                                'Stop the debug instance and disconnect Core DSH?'
                              )
                            ),
                            createElement(
                              'div',
                              { className: 'flex gap-1' },
                              actionButton({
                                children: t('workbench.cancel', 'Cancel'),
                                className:
                                  'flex-1 justify-center text-text-secondary hover:bg-muted hover:text-text-primary',
                                onClick: () => setStopConfirmationOpen(false),
                                testId: 'wework-plugin-development-sidebar-stop-cancel',
                              }),
                              actionButton({
                                children: t(
                                  'workbench.plugin_development_stop_confirm',
                                  'Stop debugging'
                                ),
                                className:
                                  'flex-1 justify-center bg-destructive/10 text-destructive hover:bg-destructive/15',
                                disabled: Boolean(busy),
                                onClick: () => {
                                  setMoreOpen(false)
                                  setStopConfirmationOpen(false)
                                  void run('stop', 'pluginDevelopment.stop')
                                },
                                testId: 'wework-plugin-development-sidebar-stop',
                              })
                            )
                          )
                        : actionButton({
                            children: t('workbench.plugin_development_stop', 'Stop debugging'),
                            className:
                              'w-full justify-start text-destructive hover:bg-destructive/10',
                            disabled: !running || Boolean(busy),
                            onClick: () => setStopConfirmationOpen(true),
                            testId: 'wework-plugin-development-sidebar-stop-request',
                          })
                    )
                  : null
              )
            : null
        ),
        createElement(
          'section',
          {
            className: 'mt-6 w-full max-w-3xl',
            'data-testid': 'wework-plugin-development-debug-target',
          },
          createElement(
            'p',
            { className: 'mb-2 text-xs font-medium text-text-secondary' },
            t('workbench.plugin_development_target', 'Debug target')
          ),
          createElement(
            'div',
            { className: 'overflow-hidden rounded-xl border border-border/60' },
            createElement(
              'div',
              {
                className: 'grid grid-cols-3 divide-x divide-border/60 bg-background',
              },
              targetCell(
                t('workbench.plugin_development_current_project', 'Current project'),
                displayName,
                compactPath(sourceRoot)
              ),
              targetCell(
                'Core DSH',
                coreConnected
                  ? t('workbench.plugin_development_connected', 'Connected')
                  : t('workbench.plugin_development_waiting', 'Waiting'),
                currentSession?.coreDshPid
                  ? `${t('workbench.plugin_development_process_id', 'Process ID')} ${currentSession.coreDshPid}`
                  : ''
              ),
              createElement(
                'div',
                { className: 'min-w-0 px-3 py-3' },
                createElement(
                  'p',
                  { className: 'text-xs text-text-tertiary' },
                  t('workbench.plugin_development_debug_instance', 'Wework debug instance')
                ),
                createElement(
                  'p',
                  { className: 'mt-1 truncate text-sm font-medium' },
                  running
                    ? statusView.label
                    : t('workbench.plugin_development_not_started', 'Not started')
                ),
                createElement(
                  'p',
                  { className: 'mt-1 truncate font-mono text-xs text-text-tertiary' },
                  `${t('workbench.plugin_development_instance_id', 'Instance ID')} ${compactIdentifier(currentSession?.id)}`
                ),
                actionButton({
                  children:
                    busy === 'start'
                      ? t('workbench.plugin_development_starting', 'Starting…')
                      : running
                        ? t('workbench.plugin_development_open_instance', 'Open debug instance')
                        : t('workbench.plugin_development_start', 'Start debug instance'),
                  className:
                    'mt-3 w-full justify-center bg-text-primary text-background hover:bg-text-primary/80',
                  disabled: !sourceRoot || Boolean(busy),
                  onClick: () =>
                    running
                      ? run('focus', 'pluginDevelopment.focus')
                      : run('start', 'pluginDevelopment.start', { sourceRoot }),
                  testId: running
                    ? 'wework-plugin-development-sidebar-focus'
                    : 'wework-plugin-development-sidebar-start',
                })
              )
            )
          ),
          createElement(
            'div',
            {
              className: `mt-3 grid gap-3 ${stableRunning ? 'grid-cols-4' : 'grid-cols-2'}`,
              'data-testid': 'wework-plugin-development-lifecycle',
            },
            lifecycleStep(
              t('workbench.plugin_development_lifecycle_registered', 'Project registered'),
              true
            ),
            lifecycleStep(
              t('workbench.plugin_development_lifecycle_core', 'Core DSH started'),
              coreConnected
            ),
            lifecycleStep(
              t('workbench.plugin_development_lifecycle_loaded', 'Plugin loaded'),
              pluginLoaded
            ),
            lifecycleStep(
              t('workbench.plugin_development_lifecycle_hmr', 'HMR connected'),
              hmrConnected
            )
          )
        ),
        error
          ? createElement(
              'div',
              {
                'data-testid': 'wework-plugin-development-sidebar-error',
                className:
                  'mt-4 w-full max-w-xl whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive',
              },
              error
            )
          : null,
        currentSession?.lastError && !running
          ? createElement(
              'pre',
              {
                'data-testid': 'wework-plugin-development-sidebar-last-error',
                className:
                  'mt-4 w-full max-w-xl whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive',
              },
              `${currentSession.lastError.stage}: ${currentSession.lastError.message}`
            )
          : null,
        running
          ? createElement(
              React.Fragment,
              null,
              createElement(
                'section',
                {
                  className:
                    'mt-6 w-full max-w-3xl overflow-hidden rounded-xl border border-border/60',
                  'data-testid': 'wework-plugin-development-live-status',
                },
                createElement(
                  'div',
                  { className: 'flex h-10 items-center justify-between px-3' },
                  createElement(
                    'p',
                    { className: 'text-sm font-medium' },
                    t('workbench.plugin_development_live_status', 'Live status')
                  ),
                  createElement(
                    'span',
                    { className: 'text-xs text-text-tertiary' },
                    currentSession?.lastError
                      ? t('workbench.plugin_development_has_errors', 'Needs attention')
                      : t('workbench.plugin_development_no_errors', 'No errors')
                  )
                ),
                createElement(
                  'div',
                  {
                    className: 'grid grid-cols-3 border-t border-border/60 bg-muted/20',
                  },
                  targetCell(
                    t('workbench.plugin_development_hmr_generation', 'HMR generation'),
                    String(hmrGeneration)
                  ),
                  targetCell(
                    t('workbench.plugin_development_last_update', 'Last update'),
                    relativeTimestamp(currentSession?.hmrUpdatedAt || currentSession?.updatedAt, t)
                  ),
                  targetCell(
                    t('workbench.plugin_development_process_id', 'Process ID'),
                    currentSession?.coreDshPid
                      ? String(currentSession.coreDshPid)
                      : t('workbench.plugin_development_waiting', 'Waiting')
                  )
                )
              ),
              createElement(
                'section',
                {
                  className:
                    'mt-3 w-full max-w-3xl overflow-hidden rounded-xl border border-border/60',
                  'data-testid': 'wework-plugin-development-activity',
                },
                createElement(
                  'div',
                  {
                    className:
                      'flex min-h-10 flex-wrap items-center justify-between gap-2 px-2 py-1',
                  },
                  createElement(
                    'p',
                    { className: 'px-1 text-sm font-medium' },
                    t('workbench.plugin_development_recent_activity', 'Recent activity')
                  ),
                  createElement(
                    'div',
                    { className: 'flex items-center gap-1' },
                    eventFilterButton({
                      active: eventFilter === 'all',
                      children: t('workbench.plugin_development_filter_all', 'All'),
                      onClick: () => setEventFilter('all'),
                      testId: 'wework-plugin-development-filter-all',
                    }),
                    eventFilterButton({
                      active: eventFilter === 'hmr',
                      children: 'HMR',
                      onClick: () => setEventFilter('hmr'),
                      testId: 'wework-plugin-development-filter-hmr',
                    }),
                    eventFilterButton({
                      active: eventFilter === 'error',
                      children: t('workbench.plugin_development_filter_errors', 'Errors'),
                      onClick: () => setEventFilter('error'),
                      testId: 'wework-plugin-development-filter-errors',
                    })
                  )
                ),
                createElement(
                  'div',
                  { className: 'border-t border-border/60' },
                  filteredEvents.length
                    ? filteredEvents.map(event => eventRow(event))
                    : createElement(
                        'p',
                        {
                          className: 'px-3 py-3 text-xs text-text-tertiary',
                          'data-testid': 'wework-plugin-development-events-empty',
                        },
                        eventFilter === 'error'
                          ? t('workbench.plugin_development_no_errors', 'No errors')
                          : t(
                              'workbench.plugin_development_no_matching_events',
                              'No matching events'
                            )
                      )
                )
              ),
              createElement(
                'section',
                {
                  className:
                    'mt-3 w-full max-w-3xl overflow-hidden rounded-xl border border-border/60',
                  'data-testid': 'wework-plugin-development-diagnostics',
                },
                sectionButton({
                  children: t('workbench.plugin_development_tools', 'Diagnostic tools'),
                  collapsedLabel: t('workbench.plugin_development_expand', 'Expand'),
                  expanded: diagnosticsOpen,
                  expandedLabel: t('workbench.plugin_development_collapse', 'Collapse'),
                  onClick: () => setDiagnosticsOpen(value => !value),
                  testId: 'wework-plugin-development-diagnostics-toggle',
                }),
                diagnosticsOpen
                  ? createElement(
                      'div',
                      { className: 'border-t border-border/60' },
                      actionButton({
                        children: createElement(
                          'span',
                          { className: 'min-w-0 text-left' },
                          createElement(
                            'span',
                            { className: 'block text-sm text-text-primary' },
                            t('workbench.plugin_development_restart_core_dsh', 'Restart Core DSH')
                          ),
                          createElement(
                            'span',
                            { className: 'block text-xs font-normal text-text-tertiary' },
                            t(
                              'workbench.plugin_development_restart_description',
                              'Restart the plugin runtime without closing the debug instance'
                            )
                          )
                        ),
                        className:
                          'h-auto min-h-12 w-full justify-start rounded-none px-3 py-2 hover:bg-muted/50',
                        disabled: Boolean(busy),
                        onClick: () => run('restart', 'pluginDevelopment.restartCoreDsh'),
                        testId: 'wework-plugin-development-sidebar-restart',
                      }),
                      createElement('div', { className: 'mx-3 h-px bg-border/60' }),
                      actionButton({
                        children: createElement(
                          'span',
                          { className: 'min-w-0 text-left' },
                          createElement(
                            'span',
                            { className: 'block text-sm text-text-primary' },
                            t('workbench.plugin_development_open_devtools', 'Open DevTools')
                          ),
                          createElement(
                            'span',
                            { className: 'block text-xs font-normal text-text-tertiary' },
                            t(
                              'workbench.plugin_development_devtools_description',
                              'Inspect the renderer of the running debug instance'
                            )
                          )
                        ),
                        className:
                          'h-auto min-h-12 w-full justify-start rounded-none px-3 py-2 hover:bg-muted/50',
                        disabled: Boolean(busy),
                        onClick: () => run('devtools', 'pluginDevelopment.openDevTools'),
                        testId: 'wework-plugin-development-sidebar-devtools',
                      }),
                      createElement('div', { className: 'mx-3 h-px bg-border/60' }),
                      actionButton({
                        children: createElement(
                          'span',
                          { className: 'min-w-0 text-left' },
                          createElement(
                            'span',
                            { className: 'block text-sm text-text-primary' },
                            t('workbench.plugin_development_logs', 'Open logs folder')
                          ),
                          createElement(
                            'span',
                            { className: 'block truncate text-xs font-normal text-text-tertiary' },
                            compactPath(currentSession?.logDirectory || '')
                          )
                        ),
                        className:
                          'h-auto min-h-12 w-full justify-start rounded-none px-3 py-2 hover:bg-muted/50',
                        disabled: Boolean(busy),
                        onClick: () => run('logs', 'pluginDevelopment.openLogDirectory'),
                        testId: 'wework-plugin-development-sidebar-logs',
                      })
                    )
                  : null
              )
            )
          : createElement(
              'p',
              { className: 'mt-6 w-full max-w-3xl text-sm text-text-secondary' },
              t(
                'workbench.plugin_development_stopped_hint',
                'Start a separate Wework instance to load and debug this plugin.'
              )
            )
      )
    }

    const contributions = [
      {
        slot: 'wework.plugins.action',
        descriptor: {
          id: 'wework-plugin-developer.create',
          label: 'Create plugin',
          labelKey: 'workbench.plugin_development_create',
          order: 10,
        },
        component: CreatePluginAction,
      },
      {
        slot: 'wework.workspace.sidebar.tab',
        descriptor: {
          id: 'wework-plugin-developer.debug',
          label: 'Plugin debugging',
          labelKey: 'workbench.plugin_development_debug',
          order: 15,
          when: {
            projectKinds: ['wework-core-dsh-plugin'],
          },
        },
        component: PluginDebugPanel,
      },
    ]

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        for (const contribution of contributions) {
          ctx.slots.inject(contribution.slot, () =>
            ctx.wework.ui.register(
              ctx,
              contribution.slot,
              contribution.descriptor,
              contribution.component
            )
          )
        }
      },
    }
  },
})
