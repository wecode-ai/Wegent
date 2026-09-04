window.__ModuleLoader__.load({
  id: '@wegent/dsh-electron-host',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const BASE_PATH = '/wework/electron-host/v1'

    class WeworkDesktopClientError extends Error {
      constructor(code, message, details = {}) {
        super(message)
        this.name = 'WeworkDesktopClientError'
        this.code = code
        this.details = details
      }
    }

    function createWeworkDesktopClient(fetchImpl = window.fetch.bind(window)) {
      let active = true

      function assertActive() {
        if (!active) {
          throw new WeworkDesktopClientError(
            'service_disposed',
            'Wework desktop client belongs to a disposed Renderer generation'
          )
        }
      }

      async function request(path, init) {
        assertActive()
        let response
        try {
          response = await fetchImpl(`${BASE_PATH}${path}`, {
            credentials: 'same-origin',
            cache: 'no-store',
            ...init,
          })
        } catch (error) {
          throw new WeworkDesktopClientError(
            'host_unreachable',
            error instanceof Error ? error.message : String(error)
          )
        }
        let body
        try {
          body = await response.json()
        } catch {
          throw new WeworkDesktopClientError(
            'invalid_host_response',
            'Electron host returned invalid JSON'
          )
        }
        if (!response.ok || body?.ok === false) {
          const error = body?.error
          throw new WeworkDesktopClientError(
            typeof error?.code === 'string' ? error.code : 'capability_failed',
            typeof error?.message === 'string'
              ? error.message
              : `Electron host request failed with HTTP ${response.status}`,
            error?.details && typeof error.details === 'object' ? error.details : {}
          )
        }
        assertActive()
        return path === '' ? body : body?.result
      }

      function invoke(capability, params = {}) {
        return request('/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capability, params }),
        })
      }

      const service = Object.freeze({
        app: Object.freeze({
          getVersion: () => invoke('app.getVersion'),
        }),
        window: Object.freeze({
          getState: () => invoke('window.getState'),
          minimize: () => invoke('window.minimize'),
          toggleMaximize: () => invoke('window.toggleMaximize'),
          close: () => invoke('window.close'),
        }),
        dialog: Object.freeze({
          open: options => invoke('dialog.open', options),
          save: options => invoke('dialog.save', options),
          message: options => invoke('dialog.message', options),
        }),
        notification: Object.freeze({
          show: options => invoke('notification.show', options),
        }),
        browser: Object.freeze({
          setRequestHeaderRule: rule => invoke('browser.setRequestHeaderRule', rule),
          removeRequestHeaderRule: id => invoke('browser.removeRequestHeaderRule', { id }),
          createBackgroundPage: id => invoke('browser.createBackgroundPage', { id }),
          navigateBackgroundPage: (id, url) =>
            invoke('browser.navigateBackgroundPage', { id, url }),
          setBackgroundPageUserAgent: (id, userAgent) =>
            invoke('browser.setBackgroundPageUserAgent', { id, userAgent }),
          backgroundPageState: id => invoke('browser.backgroundPageState', { id }),
          closeBackgroundPage: id => invoke('browser.closeBackgroundPage', { id }),
        }),
        secureStorage: Object.freeze({
          get: key => invoke('secureStorage.get', { key }),
          set: (key, value) => invoke('secureStorage.set', { key, value }),
          delete: key => invoke('secureStorage.delete', { key }),
        }),
        rendererHealth: Object.freeze({
          getState: () => invoke('rendererHealth.getState'),
        }),
        runtime: Object.freeze({
          restartCoreDsh: () => invoke('runtime.restartCoreDsh'),
        }),
        shell: Object.freeze({
          openExternal: url => invoke('shell.openExternal', { url }),
        }),
        describe: () => request('', { method: 'GET' }),
      })

      return {
        service,
        dispose() {
          active = false
        },
      }
    }

    const inject = []
    function apply(ctx) {
      const generation = createWeworkDesktopClient()
      ctx.provide('weworkDesktop', generation.service)
      ctx.effect(
        () => () => generation.dispose(),
        'wework-electron-host: renderer desktop service generation'
      )
    }

    exports.WeworkDesktopClientError = WeworkDesktopClientError
    exports.apply = apply
    exports.createWeworkDesktopClient = createWeworkDesktopClient
    exports.inject = inject
    return module.exports
  },
})
