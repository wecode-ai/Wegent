const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('weworkStartupRecovery', {
  retry: () => ipcRenderer.invoke('startup-recovery:retry'),
  recoverWorkbench: () => ipcRenderer.invoke('startup-recovery:recover-workbench'),
  resetAppState: () => ipcRenderer.invoke('startup-recovery:reset-app-state'),
})
