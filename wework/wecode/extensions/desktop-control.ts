import type { DesktopControlExtension } from '@/extensions/desktop-control-contract'
import {
  closeEmbeddedBrowser,
  evalEmbeddedBrowserJson,
  openEmbeddedBrowser,
  relabelEmbeddedBrowser,
  setEmbeddedBrowserBounds,
} from '@/lib/embedded-browser'
import { openCloudDesktop } from '@wecode/features/vnc/openCloudDesktop'

export const desktopControlExtension: DesktopControlExtension = {
  async execute(command) {
    switch (command.action) {
      case 'closeEmbeddedBrowser':
        await closeEmbeddedBrowser(command.selector || undefined)
        return { handled: true, value: '' }
      case 'evalEmbeddedBrowserJson': {
        const expression = command.value?.trim()
        if (!expression) throw new Error('evalEmbeddedBrowserJson requires an expression')
        const value = await evalEmbeddedBrowserJson(expression, command.selector || undefined)
        return { handled: true, value: JSON.stringify(value) }
      }
      case 'openEmbeddedCloudDesktop': {
        const options = JSON.parse(command.value ?? '{}') as Record<string, unknown>
        const apiBaseUrl = options.apiBaseUrl
        const deviceId = options.deviceId
        const socketBaseUrl = options.socketBaseUrl
        const token = options.token
        if (
          typeof apiBaseUrl !== 'string' ||
          typeof deviceId !== 'string' ||
          typeof socketBaseUrl !== 'string' ||
          typeof token !== 'string'
        ) {
          throw new Error('openEmbeddedCloudDesktop requires cloud connection options')
        }
        const opened = await openCloudDesktop({
          connection: {
            apiBaseUrl,
            isConnected: true,
            socketBaseUrl,
            token,
          },
          deviceId,
          isCurrent: () => true,
          target: 'embedded',
        })
        if (!opened) throw new Error('Embedded cloud desktop request became stale')
        return { handled: true, value: '' }
      }
      case 'prepareEmbeddedBrowserRelabelRegression': {
        const bounds = { x: 0, y: 0, width: 1, height: 1 }
        const ownerLabel = 'workspace-browser-regression-owner'
        await openEmbeddedBrowser('https://example.com/', bounds, 'workspace-browser')
        await relabelEmbeddedBrowser('workspace-browser', ownerLabel)
        await setEmbeddedBrowserBounds(bounds, false, ownerLabel)
        return { handled: true, value: '' }
      }
      default:
        return { handled: false }
    }
  },
}
