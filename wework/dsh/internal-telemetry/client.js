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
      let stopRouteCapture = null

      ctx.effect(() => {
        void registerWhenReady()
        return () => {
          active = false
          unregister?.()
          unregister = null
          stopRouteCapture?.()
          stopRouteCapture = null
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

        stopRouteCapture = captureSmartAppRoutes(backend)

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

function captureSmartAppRoutes(backend) {
  let lastInstallationId = null
  const history = window.history
  const cleanup = []

  const capture = () => {
    const installationId = readSmartAppInstallationId(window.location?.pathname)
    if (!installationId) {
      lastInstallationId = null
      return
    }
    if (installationId === lastInstallationId) return

    const eventId = window.crypto?.randomUUID?.()
    if (!isUuid(eventId)) return

    lastInstallationId = installationId
    const envelope = enrichEnvelope({
      eventId,
      name: 'smart_app_opened',
      occurredAt: new Date().toISOString(),
      properties: { domain: 'smart_app' },
    })
    try {
      Promise.resolve(
        backend.request('accept', { envelope, smartAppInstallationId: installationId })
      ).catch(() => {})
    } catch {}
  }

  const onPopState = () => capture()
  window.addEventListener?.('popstate', onPopState)
  cleanup.push(() => window.removeEventListener?.('popstate', onPopState))

  for (const method of ['pushState', 'replaceState']) {
    const original = history?.[method]
    if (typeof original !== 'function') continue

    const wrapped = function (...args) {
      const result = original.apply(this, args)
      capture()
      return result
    }
    try {
      history[method] = wrapped
      cleanup.push(() => {
        if (history[method] === wrapped) history[method] = original
      })
    } catch {}
  }

  capture()
  return () => {
    for (const dispose of cleanup.splice(0).reverse()) dispose()
  }
}

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

function readSmartAppInstallationId(pathname) {
  if (typeof pathname !== 'string') return null
  const match = pathname.match(/(?:^|\/)app\/harness-([^/]+)$/)
  if (!match) return null

  try {
    const installationId = decodeURIComponent(match[1])
    return isBoundedString(installationId) ? installationId : null
  } catch {
    return null
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

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}
