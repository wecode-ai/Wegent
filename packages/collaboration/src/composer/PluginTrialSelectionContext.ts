import { createContext } from 'react'
import type { LocalDeviceApp } from '@wegent/chat-core/runtime-composer-catalog'

/** Selection stays inside the owning composer, including portalled menus. */
export const PluginTrialSelectionContext = createContext<
  ((title: string, app: LocalDeviceApp) => void) | undefined
>(undefined)
