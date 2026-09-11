const BACKEND_ID = 'wework-internal-telemetry'
const CATALOG_VERSION = 1
const CLOUD_CONNECTION_STORAGE_KEY = 'wework.cloudConnection'
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
                const identity = readCloudIdentity(window.localStorage)
                Promise.resolve(
                  backend.request('accept', identity ? { envelope, identity } : { envelope })
                ).catch(() => {})
              } catch {}
            },
          })
        } catch {}
      }
    },
  }),
})

function readCloudIdentity(storage) {
  try {
    const serialized = storage?.getItem?.(CLOUD_CONNECTION_STORAGE_KEY)
    if (typeof serialized !== 'string') return undefined
    const email = JSON.parse(serialized)?.user?.email
    if (typeof email !== 'string') return undefined
    const emailPrefix = email.trim().split('@', 1)[0]
    if (!isEmailPrefix(emailPrefix)) return undefined
    return { emailPrefix }
  } catch {
    return undefined
  }
}

function isEmailPrefix(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/\s/.test(value) &&
    !value.includes('@')
  )
}
