window.__ModuleLoader__.load({
  id: '@wegent/dsh-transcript-sync',
  factory: () => {
    const CONFIGURATION_ID = 'wework-transcript-sync.settings'
    const BACKEND_ID = 'wework-transcript-sync'

    function createSettingsStore(service) {
      const backend = service.backend.scope(BACKEND_ID)
      let snapshot = {
        enabled: false,
        error: null,
        pending: true,
        status: null,
        statusPending: false,
        statusRefreshing: false,
      }
      const listeners = new Set()
      let statusTimer
      const publish = patch => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener(snapshot)
      }
      const store = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            void store.refreshStatus()
            statusTimer = setInterval(() => void store.refreshStatus(), 5000)
          }
          return () => {
            listeners.delete(listener)
            if (!listeners.size) {
              clearInterval(statusTimer)
              statusTimer = undefined
            }
          }
        },
        async reconcile() {
          try {
            const settings = await backend.request('getSettings', {})
            const enabled = settings?.enabled === true
            service.configuration.update(CONFIGURATION_ID, { enabled })
            publish({ enabled, error: null, pending: false })
            await this.refreshStatus()
          } catch (error) {
            publish({
              error: error instanceof Error ? error.message : String(error),
              pending: false,
            })
          }
        },
        async refreshStatus({ showPending = false } = {}) {
          if (snapshot.statusRefreshing) return
          publish({
            statusRefreshing: true,
            ...(showPending ? { statusPending: true } : {}),
          })
          try {
            const status = await backend.request('getStatus', {})
            const enabled = status?.enabled === true
            service.configuration.update(CONFIGURATION_ID, { enabled })
            publish({ enabled, status, statusPending: false, statusRefreshing: false })
          } catch (error) {
            publish({
              error: error instanceof Error ? error.message : String(error),
              statusPending: false,
              statusRefreshing: false,
            })
          }
        },
        async retry() {
          if (snapshot.statusRefreshing) return
          publish({ error: null, statusPending: true, statusRefreshing: true })
          try {
            const status = await backend.request('flush', {})
            publish({ status, statusPending: false, statusRefreshing: false })
          } catch (error) {
            publish({
              error: error instanceof Error ? error.message : String(error),
              statusPending: false,
              statusRefreshing: false,
            })
            await this.refreshStatus()
          }
        },
        async setEnabled(enabled) {
          if (snapshot.pending || snapshot.enabled === enabled) return
          publish({ error: null, pending: true })
          try {
            await backend.request('setEnabled', { enabled })
            service.configuration.update(CONFIGURATION_ID, { enabled })
            publish({ enabled, pending: false })
            await this.refreshStatus({ showPending: true })
          } catch (error) {
            publish({
              error: error instanceof Error ? error.message : String(error),
              pending: false,
            })
          }
        },
      }
      return store
    }

    return {
      inject: ['wework'],
      apply(ctx) {
        ctx.wework.configuration.register(ctx, {
          defaults: { enabled: false },
          description: 'Controls Wework transcript and portable preference cloud synchronization.',
          id: CONFIGURATION_ID,
          properties: {
            enabled: { type: 'boolean' },
          },
          title: 'Wework cloud synchronization',
          validate(value) {
            if (typeof value.enabled !== 'boolean') {
              throw new Error('Cloud synchronization enabled must be a boolean')
            }
          },
        })
        const store = createSettingsStore(ctx.wework)
        void store.reconcile()
        ctx.wework.contributions.register(ctx, 'wework.settings.section', {
          experimental: true,
          id: 'wework-transcript-sync',
          label: ctx.wework.localization.translate({ en: 'Cloud sync', 'zh-CN': '云同步' }),
          module: 'plugins/wework-ui-transcript-sync-settings.js',
          order: 90,
          page: 'connections',
          // Share state with the host renderer across the DSH React boundary.
          store,
        })
      },
    }
  },
})
