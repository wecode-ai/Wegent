export const OPEN_COMPOSER_SLASH_MENU_EVENT = 'wework:open-composer-slash-menu'
export const OPEN_COMPOSER_PLUGIN_PICKER_EVENT = 'wework:open-composer-plugin-picker'

export function openComposerSlashMenu() {
  window.dispatchEvent(new Event(OPEN_COMPOSER_SLASH_MENU_EVENT))
}

export function openComposerPluginPicker() {
  window.dispatchEvent(new Event(OPEN_COMPOSER_PLUGIN_PICKER_EVENT))
}
