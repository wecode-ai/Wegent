import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('weworkElectron', {
  getRuntimeState: () => ipcRenderer.invoke('runtime:get-state'),
  onRuntimeChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('runtime:changed', handler)
    return () => ipcRenderer.off('runtime:changed', handler)
  },
  reloadDsh: () => ipcRenderer.invoke('runtime:reload-dsh'),
})
