import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('weworkElectronCloudCredentials', {
  refreshAccessToken: (apiBaseUrl: string, expectedUserId: number) =>
    ipcRenderer.invoke('cloud-credentials:refresh-access-token', apiBaseUrl, expectedUserId),
})
