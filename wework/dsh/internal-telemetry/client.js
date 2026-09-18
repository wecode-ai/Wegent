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
                const enrichedEnvelope = enrichEnvelope(envelope)
                Promise.resolve(backend.request('accept', { envelope: enrichedEnvelope })).catch(
                  () => {}
                )
              } catch {}
            },
          })
        } catch {}
      }
    },
  }),
})

function enrichEnvelope(envelope) {
  if (
    !isRecord(envelope) ||
    envelope.name !== 'smart_app_opened' ||
    isRecord(envelope.context?.smartApp)
  ) {
    return envelope
  }

  const smartAppName = readActiveSmartAppName()
  if (!smartAppName) return envelope

  return {
    ...envelope,
    properties: {
      ...(isRecord(envelope.properties) ? envelope.properties : {}),
      smart_app_name: smartAppName,
    },
  }
}

function readActiveSmartAppName() {
  const pathname = window.location?.pathname ?? ''
  if (!/\/app\/harness-[^/]+$/.test(pathname)) return null

  const tab = window.document?.querySelector?.(
    'button[role="tab"][aria-selected="true"][data-tab-kind="auxiliary"]'
  )
  const title = tab?.getAttribute?.('title')
  return isBoundedString(title) ? title.trim() : null
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value) {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= 128
}
