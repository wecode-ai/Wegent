const BACKEND_ID = 'wework-internal-telemetry'
const CATALOG_VERSION = 1
const SINK_ID = 'wegent-internal-telemetry'
const SINK_PROTOCOL = 'telemetry-sink/v1'

window.__ModuleLoader__.load({
  id: '@wegent/dsh-internal-telemetry',
  factory: () => ({
    inject: ['wework'],
    apply(ctx) {
      const backend = ctx.wework.backend.scope(BACKEND_ID)
      let active = true
      let unregister = null

      ctx.effect(() => {
        void registerWhenReady()
        return () => {
          active = false
          unregister?.()
          unregister = null
        }
      }, 'wework-internal-telemetry: telemetry sink')

      async function registerWhenReady() {
        let ready
        try {
          ready = await backend.request('ready', {})
        } catch {
          return
        }

        if (
          !active ||
          !ready?.enabled ||
          ready.protocol !== SINK_PROTOCOL ||
          ready.catalogVersion !== CATALOG_VERSION
        ) {
          return
        }

        try {
          unregister = ctx.wework.telemetry.sinks.register(ctx, {
            id: SINK_ID,
            protocol: SINK_PROTOCOL,
            accept(envelope) {
              try {
                Promise.resolve(backend.request('accept', { envelope })).catch(() => {})
              } catch {}
            },
          })
        } catch {}
      }
    },
  }),
})
