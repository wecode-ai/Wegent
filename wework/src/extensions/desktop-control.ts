import type { DesktopControlExtension } from './desktop-control-contract'

export const desktopControlExtension: DesktopControlExtension = {
  execute: async () => ({ handled: false }),
}
