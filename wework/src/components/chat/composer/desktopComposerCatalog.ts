import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'
import {
  COMPOSER_APPS_REQUEST_SYNC_EVENT,
  getComposerApps,
  publishComposerApps,
  replaceComposerApps,
  shouldSuppressComposerAppsSync,
  subscribeComposerApps,
} from './composerAppsSnapshot'
export const desktopComposerCatalogStore = {
  get: getComposerApps,
  readSnapshot: getComposerApps,
  publish: publishComposerApps,
  replace: replaceComposerApps,
  subscribe: subscribeComposerApps,
  suppressSync: shouldSuppressComposerAppsSync,
}
export const desktopComposerCatalogEvents = {
  requestSync: COMPOSER_APPS_REQUEST_SYNC_EVENT,
  catalogChanged: LOCAL_PLUGIN_SKILLS_CHANGED_EVENT,
}
