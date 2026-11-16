const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const invoke = (action: string) => ipcRenderer.invoke('startup-recovery-window', action)

contextBridge.exposeInMainWorld('weworkElectron', {
  getRuntimeState: () => invoke('state'),
  reloadDsh: () => invoke('retry'),
  copyStartupDiagnostics: () => invoke('copy'),
  openStartupLogs: () => invoke('logs'),
  onRuntimeChanged: (listener: () => void) => {
    ipcRenderer.on('runtime:changed', listener)
    return () => ipcRenderer.off('runtime:changed', listener)
  },
})
