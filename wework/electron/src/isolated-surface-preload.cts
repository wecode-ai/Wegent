import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('weworkElectronCloudCredentials', {
  refreshAccessToken: (apiBaseUrl: string) =>
    ipcRenderer.invoke('cloud-credentials:refresh-access-token', apiBaseUrl),
})
