import type { ModelSelectorCloseReason } from './model-selector-types'

export type DesktopModelMenuView = 'simple' | 'advanced'
interface PopoverInput {
  isMobile: boolean
  disabled?: boolean
  openSignal?: number
  renderedOpen: boolean
  onOpenChange?(open: boolean, reason?: ModelSelectorCloseReason): void
  onFlyoutOpenChange?(open: boolean): void
}

/** Own model picker presentation; an open signal never selects a model or changes its options. */
export function createModelSelectorPopover() {
  let state = {
    open: false,
    closeReason: 'dismiss' as ModelSelectorCloseReason,
    mobileQuery: '',
    desktopView: 'simple' as DesktopModelMenuView,
  }
  let input: PopoverInput | undefined
  let handledSignal: number | undefined
  let observationRevision = 0
  let reportedFlyout = false
  let flyoutCallback: PopoverInput['onFlyoutOpenChange']
  const listeners = new Set<() => void>()
  function reportFlyout() {
    if (!listeners.size) return
    const flyout = state.open && !input?.isMobile
    if (flyout === reportedFlyout && flyoutCallback === input?.onFlyoutOpenChange) return
    if (flyoutCallback !== input?.onFlyoutOpenChange) flyoutCallback?.(false)
    reportedFlyout = flyout
    flyoutCallback = input?.onFlyoutOpenChange
    flyoutCallback?.(flyout)
  }
  function update(next: typeof state) {
    if (
      Object.keys(next).every(
        key => next[key as keyof typeof next] === state[key as keyof typeof state]
      )
    )
      return
    const openChanged = next.open !== state.open
    state = next
    listeners.forEach(listener => listener())
    if (openChanged && listeners.size)
      input?.onOpenChange?.(state.open, state.open ? undefined : state.closeReason)
    reportFlyout()
  }
  const open = () => {
    if (input?.disabled) return
    update({ ...state, open: true, closeReason: 'dismiss' })
  }
  return {
    getSnapshot: () => state,
    open,
    close(reason: ModelSelectorCloseReason = 'dismiss') {
      update({ ...state, open: false, closeReason: reason, mobileQuery: '', desktopView: 'simple' })
    },
    setMobileQuery(value: string | ((current: string) => string)) {
      update({
        ...state,
        mobileQuery: typeof value === 'function' ? value(state.mobileQuery) : value,
      })
    },
    setDesktopView(value: DesktopModelMenuView) {
      update({ ...state, desktopView: value })
    },
    subscribe(listener: () => void, next: PopoverInput) {
      const revision = ++observationRevision
      input = next
      listeners.add(listener)
      reportFlyout()
      if (
        next.renderedOpen === state.open &&
        next.openSignal &&
        !next.disabled &&
        !state.open &&
        handledSignal !== next.openSignal
      ) {
        handledSignal = next.openSignal
        open()
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || revision !== observationRevision) return
          next.onFlyoutOpenChange?.(false)
          reportedFlyout = false
          flyoutCallback = undefined
        })
      }
    },
  }
}
