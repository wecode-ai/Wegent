const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('weworkStartupRecovery', {
  retry: () => ipcRenderer.invoke('startup-recovery:retry'),
  recoverWorkbench: () => ipcRenderer.invoke('startup-recovery:recover-workbench'),
  resetAppState: () => ipcRenderer.invoke('startup-recovery:reset-app-state'),
  disablePlugin: (name: string) => ipcRenderer.invoke('startup-recovery:disable-plugin', name),
})

contextBridge.exposeInMainWorld('weworkStartupProgress', {
  onUpdate: (listener: (update: unknown) => void) => {
    ipcRenderer.on('startup-progress:update', (_event: unknown, update: unknown) =>
      listener(update)
    )
  },
})
