import { contextBridge, ipcRenderer } from 'electron'

const argument = process.argv.find(value => value.startsWith('--wework-workbench-install-channel='))
const channel = argument?.slice('--wework-workbench-install-channel='.length)
if (channel && /^workbench-install:[a-f0-9-]+$/.test(channel)) {
  contextBridge.exposeInMainWorld('weworkWorkbenchInstallation', {
    respond: (accepted: boolean) => {
      if (typeof accepted === 'boolean') ipcRenderer.send(channel, accepted)
    },
  })
}
