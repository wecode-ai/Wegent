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

contextBridge.exposeInMainWorld('weworkElectronExecutionEnvironments', {
  list: () => ipcRenderer.invoke('runtime:list-execution-environments'),
  chooseNodeExecutable: () => ipcRenderer.invoke('runtime:choose-node-executable'),
  useBuiltinNode: () => ipcRenderer.invoke('runtime:use-builtin-node'),
})
