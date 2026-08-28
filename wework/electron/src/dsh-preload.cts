import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { exposeStartupShellBridge } from './host/startup-shell-bridge.js'

exposeStartupShellBridge(location.protocol, contextBridge, ipcRenderer)

contextBridge.exposeInMainWorld('weworkElectronFiles', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})

contextBridge.exposeInMainWorld('weworkElectronLifecycle', {
  onSystemResume: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('system:resume', handler)
    return () => ipcRenderer.off('system:resume', handler)
  },
})

contextBridge.exposeInMainWorld('weworkElectronCloudCredentials', {
  getDevicePublicKey: () => ipcRenderer.invoke('cloud-credentials:get-device-public-key'),
  claimAuthorization: (input: { apiBaseUrl: string; sessionId: string; pollToken: string }) =>
    ipcRenderer.invoke('cloud-credentials:claim-authorization', input),
  refreshAccessToken: (apiBaseUrl: string) =>
    ipcRenderer.invoke('cloud-credentials:refresh-access-token', apiBaseUrl),
  clear: () => ipcRenderer.invoke('cloud-credentials:clear'),
})

contextBridge.exposeInMainWorld('weworkElectronExecutionEnvironments', {
  list: () => ipcRenderer.invoke('runtime:list-execution-environments'),
  chooseNodeExecutable: () => ipcRenderer.invoke('runtime:choose-node-executable'),
  useBuiltinNode: () => ipcRenderer.invoke('runtime:use-builtin-node'),
})
