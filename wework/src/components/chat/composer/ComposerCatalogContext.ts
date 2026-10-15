import { createContext, useContext } from 'react'
import type {
  ComposerCatalogEvents,
  ComposerCatalogStore,
} from '@wegent/collaboration/composer/useComposerCatalog'
import type { LocalDeviceApp, LocalDeviceSkill } from '@/types/api'
import { desktopComposerCatalogEvents, desktopComposerCatalogStore } from './desktopComposerCatalog'

export interface ComposerCatalogBinding {
  appsStore: ComposerCatalogStore<LocalDeviceApp>
  catalogEvents: ComposerCatalogEvents
  listApps?: () => Promise<LocalDeviceApp[]>
  listSkills?: () => Promise<LocalDeviceSkill[]>
}

export const ComposerCatalogContext = createContext<ComposerCatalogBinding>({
  appsStore: desktopComposerCatalogStore,
  catalogEvents: desktopComposerCatalogEvents,
})
export const useComposerCatalogBinding = () => useContext(ComposerCatalogContext)
