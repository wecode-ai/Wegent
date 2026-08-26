import { contextBridge, ipcRenderer, webUtils } from 'electron'

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
