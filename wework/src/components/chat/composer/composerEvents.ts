export const OPEN_COMPOSER_SLASH_MENU_EVENT = 'wework:open-composer-slash-menu'

export function openComposerSlashMenu() {
  window.dispatchEvent(new Event(OPEN_COMPOSER_SLASH_MENU_EVENT))
}
