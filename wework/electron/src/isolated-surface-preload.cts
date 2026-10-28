import { contextBridge, ipcRenderer } from 'electron'

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('weworkElectronHost', {
    invoke: (capability: string, params: Record<string, unknown> = {}) =>
      ipcRenderer.invoke('desktop:invoke', capability, params),
    describe: () => ipcRenderer.invoke('desktop:describe'),
  })
}

contextBridge.exposeInMainWorld('weworkElectronCloudCredentials', {
  refreshAccessToken: (apiBaseUrl: string) =>
    ipcRenderer.invoke('cloud-credentials:refresh-access-token', apiBaseUrl),
})
