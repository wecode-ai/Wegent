import { always } from '@antithesishq/bombadil'
import { actions, extract, getFingerprint } from '@antithesishq/bombadil/browser'
export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
  noConsoleErrors,
} from '@antithesishq/bombadil/browser/defaults/properties'
const appearance = extract(state => {
  const root = state.document.documentElement
  const modes = Array.from(
    state.document.querySelectorAll('[data-testid^="appearance-mode-"][aria-pressed="true"]')
  )
    .filter(el => el.getClientRects().length > 0)
    .map(el => el.getAttribute('data-testid').replace('appearance-mode-', ''))
  return {
    page: Array.from(
      state.document.querySelectorAll('[data-testid="appearance-settings-page"]')
    ).some(el => el.getClientRects().length > 0),
    mode: root.dataset.appearanceMode,
    theme: root.dataset.theme,
    dark: root.classList.contains('dark'),
    modes,
  }
})
export const selectedModeMatchesAppliedMode = always(
  () =>
    !appearance.current.page ||
    (appearance.current.modes.length === 1 &&
      appearance.current.modes[0] === appearance.current.mode)
)
export const darkClassMatchesResolvedTheme = always(
  () => appearance.current.dark === (appearance.current.theme === 'dark')
)
const targets = extract(state =>
  Array.from(
    state.document.querySelectorAll(
      '[data-testid^="appearance-mode-"],[data-testid="appearance-sidebar-translucent-toggle"]'
    )
  ).flatMap(element => {
    const rect = element.getBoundingClientRect()
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    const hit = state.document.elementFromPoint(point.x, point.y)
    return rect.width > 0 && rect.height > 0 && hit && element.contains(hit)
      ? [{ fingerprint: getFingerprint(element), point }]
      : []
  })
)
export const changeAppearance = actions(() => targets.current.map(target => ({ Click: target })))
