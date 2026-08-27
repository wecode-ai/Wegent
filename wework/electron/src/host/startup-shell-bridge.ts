import type { contextBridge, ipcRenderer } from 'electron'

type ContextBridge = Pick<typeof contextBridge, 'exposeInMainWorld'>
type IpcRenderer = Pick<typeof ipcRenderer, 'invoke' | 'off' | 'on'>

export function exposeStartupShellBridge(
  protocol: string,
  bridge: ContextBridge,
  renderer: IpcRenderer
): void {
  if (protocol !== 'file:') return

  bridge.exposeInMainWorld('weworkElectron', {
    getRuntimeState: () => renderer.invoke('runtime:get-state'),
    onRuntimeChanged: (listener: () => void) => {
      const handler = () => listener()
      renderer.on('runtime:changed', handler)
      return () => renderer.off('runtime:changed', handler)
    },
    reloadDsh: () => renderer.invoke('runtime:reload-dsh'),
  })
}
