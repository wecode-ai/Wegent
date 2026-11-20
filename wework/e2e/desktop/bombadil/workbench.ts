import { always } from '@antithesishq/bombadil'
import { actions, extract, getFingerprint } from '@antithesishq/bombadil/browser'
export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
  noConsoleErrors,
} from '@antithesishq/bombadil/browser/defaults/properties'
const shell = extract(state => Boolean(state.document.querySelector('[data-testid="app-shell"]')))
export const shellRemainsMounted = always(() => shell.current)
const targets = extract(state => {
  const ids = [
    'cloud-connection-close-button',
    'settings-button',
    'settings-back-button',
    'settings-menu-button',
    'workspace-tab-select-fixed-task',
    'workspace-tab-select-fixed-board',
    'workspace-tab-select-fixed-agent',
    'workspace-tab-select-pending-interactions',
    'toggle-bottom-workspace-panel-button',
    'toggle-right-workspace-panel-button',
    'collapse-sidebar-button',
    'titlebar-notifications',
    'model-selector-button',
    'permission-mode-menu-button',
    'composer-plugin-picker-button',
  ]
  const selector =
    ids.map(id => `[data-testid="${id}"]`).join(',') +
    ',[data-testid^="settings-nav-"],[data-testid^="settings-menu-"]'
  return Array.from(state.document.querySelectorAll(selector)).flatMap(element => {
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true')
      return []
    const rect = element.getBoundingClientRect()
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    const hit = state.document.elementFromPoint(point.x, point.y)
    if (rect.width <= 0 || rect.height <= 0 || !hit || !element.contains(hit)) return []
    return [{ fingerprint: getFingerprint(element), point }]
  })
})
export const explore = actions(() => [
  ...targets.current.map(target => ({ Click: target })),
  { PressKey: { code: 27 } },
])
