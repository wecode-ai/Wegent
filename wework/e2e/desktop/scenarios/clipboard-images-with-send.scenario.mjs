import { createDesktopScenario as createClipboardImages } from './clipboard-history-image.scenario.mjs'
import { createDesktopScenario as createImmediateSend } from './paste-image-send.scenario.mjs'

export function createDesktopScenario(options) {
  const clipboard = createClipboardImages(options)
  const immediate = createImmediateSend(options)
  return {
    ...immediate,
    async verify(control) {
      await clipboard.verify(control)
      if (process.platform === 'darwin') return immediate.verify(control)
    },
  }
}
