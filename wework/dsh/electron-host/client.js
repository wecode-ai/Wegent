window.__ModuleLoader__.load({
  id: '@wegent/dsh-electron-host',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    class WeworkDesktopClientError extends Error {
      constructor(code, message, details = {}) {
        super(message)
        this.name = 'WeworkDesktopClientError'
        this.code = code
        this.details = details
      }
    }

    function createWeworkDesktopClient() {
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
        const bridge = window.weworkElectronHost
        if (!bridge)
          throw new WeworkDesktopClientError(
            'host_unavailable',
            'Trusted desktop IPC is unavailable'
          )
        if (path === '') return bridge.describe()
        const input = JSON.parse(init.body)
        const body = await bridge.invoke(input.capability, input.params)
        assertActive()
        if (body?.ok !== true) {
          throw new WeworkDesktopClientError(
            body?.error?.code ?? 'capability_failed',
            body?.error?.message ?? 'Desktop operation failed',
            body?.error?.details
          )
        }
        return body.result
      }

      function invoke(capability, params = {}) {
        return request('/invoke', { body: JSON.stringify({ capability, params }) })
      }

      const service = Object.freeze({
        app: Object.freeze({
          getVersion: () => invoke('app.getVersion'),
        }),
        deviceDiagnostics: Object.freeze({
          microphone: (options = {}) => invoke('deviceDiagnostics.microphone', options),
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
