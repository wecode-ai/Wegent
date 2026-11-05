import { contextBridge, ipcRenderer, webUtils } from 'electron'

if (process.env.VITE_WEWORK_E2E === 'true' && process.env.WEWORK_E2E_CONTROL_URL) {
  contextBridge.exposeInMainWorld('weworkElectronVerification', {
    requestRuntime: (input: unknown) => ipcRenderer.invoke('e2e:runtime-request', input),
  })
}

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('weworkElectron', {
    getRuntimeState: () => ipcRenderer.invoke('runtime:get-state'),
    onRuntimeChanged: (listener: () => void) => {
      const handler = () => listener()
      ipcRenderer.on('runtime:changed', handler)
      return () => ipcRenderer.off('runtime:changed', handler)
    },
    reloadDsh: () => ipcRenderer.invoke('runtime:reload-dsh'),
  })
}

contextBridge.exposeInMainWorld('weworkElectronFiles', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})

contextBridge.exposeInMainWorld('weworkElectronLifecycle', {
  onSystemResume: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('system:resume', handler)
    return () => ipcRenderer.off('system:resume', handler)
  },
  onWindowFocusChanged: (listener: (focused: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, focused: boolean) => listener(focused)
    ipcRenderer.on('window:focus-changed', handler)
    return () => ipcRenderer.off('window:focus-changed', handler)
  },
})

contextBridge.exposeInMainWorld('weworkElectronCloudCredentials', {
  prepareAuthorization: (apiBaseUrl: string) =>
    ipcRenderer.invoke('cloud-credentials:prepare-authorization', apiBaseUrl),
  claimAuthorization: (input: { authorizationId: string; sessionId: string; pollToken: string }) =>
    ipcRenderer.invoke('cloud-credentials:claim-authorization', input),
  commitAuthorization: (authorizationId: string, ownerUserId: number) =>
    ipcRenderer.invoke('cloud-credentials:commit-authorization', authorizationId, ownerUserId),
  discardAuthorization: (authorizationId: string) =>
    ipcRenderer.invoke('cloud-credentials:discard-authorization', authorizationId),
  refreshAccessToken: (apiBaseUrl: string, expectedUserId: number) =>
    ipcRenderer.invoke('cloud-credentials:refresh-access-token', apiBaseUrl, expectedUserId),
  clear: () => ipcRenderer.invoke('cloud-credentials:clear'),
})

contextBridge.exposeInMainWorld('weworkElectronExecutionEnvironments', {
  list: () => ipcRenderer.invoke('runtime:list-execution-environments'),
  chooseNodeExecutable: () => ipcRenderer.invoke('runtime:choose-node-executable'),
  useBuiltinNode: () => ipcRenderer.invoke('runtime:use-builtin-node'),
})

contextBridge.exposeInMainWorld('weworkElectronNetwork', {
  resolveProxy: (targetUrl: string) => ipcRenderer.invoke('runtime:resolve-proxy', targetUrl),
})
