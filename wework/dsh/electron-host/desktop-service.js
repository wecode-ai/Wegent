import { ElectronHostError } from './electron-host-client.js'

export const WEWORK_DESKTOP_SERVICE_KEY = 'weworkDesktop'

export function createWeworkDesktopService(client) {
  let active = true

  const invoke = (capability, params = {}) => {
    if (!active) {
      return Promise.reject(
        new ElectronHostError(
          'service_disposed',
          'Wework desktop service belongs to a disposed DSH generation'
        )
      )
    }
    return client.invoke(capability, params)
  }

  const service = {
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
      navigateBackgroundPage: (id, url) => invoke('browser.navigateBackgroundPage', { id, url }),
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
    preferences: Object.freeze({
      get: () => invoke('preferences.get'),
      update: patch => invoke('preferences.update', { patch }),
    }),
    rendererHealth: Object.freeze({
      getState: () => invoke('rendererHealth.getState'),
    }),
    runtime: Object.freeze({
      restartCoreDsh: () => invoke('runtime.restartCoreDsh'),
    }),
    weworkSync: Object.freeze({
      request: request => invoke('weworkSync.request', request),
    }),
    shell: Object.freeze({
      openExternal: url => invoke('shell.openExternal', { url }),
    }),
    describe: async () => {
      if (!active) {
        throw new ElectronHostError(
          'service_disposed',
          'Wework desktop service belongs to a disposed DSH generation'
        )
      }
      return client.describe()
    },
  }

  return {
    service: Object.freeze(service),
    dispose() {
      active = false
    },
  }
}
