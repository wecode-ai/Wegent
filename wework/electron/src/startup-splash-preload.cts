const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('weworkAppearance', {
  onChanged: (listener: (appearance: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, appearance: unknown) => listener(appearance)
    ipcRenderer.on('appearance:changed', handler)
    return () => ipcRenderer.off('appearance:changed', handler)
  },
})

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

contextBridge.exposeInMainWorld('weworkStartupDiagnostics', {
  copy: () => ipcRenderer.invoke('startup-diagnostics:copy'),
  openLogs: () => ipcRenderer.invoke('startup-diagnostics:open-logs'),
})
