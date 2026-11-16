import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useDialogKeyboard } from '../controls/useDialogKeyboard'

/** A configuration step within the existing project dialog, preserving its draft. */
export function ProjectCreateConfigurationView({
  onBack,
  backLabel,
  children,
  testId,
  active = true,
  footer,
  restoreFocus,
  focusTarget,
  focusLabel,
}: {
  onBack(): void
  backLabel: string
  children: ReactNode
  testId?: string
  active?: boolean
  footer?: ReactNode
  restoreFocus?: string
  focusTarget?: string | null
  focusLabel?: string
}) {
  const ref = useDialogKeyboard<HTMLElement>(
    onBack,
    active,
    '[contenteditable="true"], input:not([disabled]), select:not([disabled]), button:not([disabled])',
    false,
    restoreFocus
  )
  const lastOwnedFocus = useRef<HTMLElement | null>(null)
  const restoreLostFocus = useCallback(() => {
    const section = ref.current
    if (!active || focusTarget === undefined || !section) return
    const current = document.activeElement
    const removedControlLostFocus =
      (current === document.body || current === null) &&
      lastOwnedFocus.current !== null &&
      !lastOwnedFocus.current.isConnected
    if (current !== section && !removedControlLostFocus) return
    const requested = focusTarget === null ? null : section.querySelector<HTMLElement>(focusTarget)
    const target =
      requested && !requested.closest('[hidden], [inert]') && !requested.matches(':disabled')
        ? requested
        : section
    if (current !== target) target.focus()
  }, [active, focusTarget, ref])
  useLayoutEffect(restoreLostFocus, [restoreLostFocus])
  // ProseMirror creates its editable DOM in a child passive effect.
  useEffect(restoreLostFocus, [restoreLostFocus])
  return (
    <section
      ref={ref}
      aria-label={focusLabel}
      onFocusCapture={event => {
        if (event.target instanceof HTMLElement && ref.current?.contains(event.target))
          lastOwnedFocus.current = event.target
      }}
      className="collaboration-project-create-configuration"
      data-testid={testId}
      tabIndex={-1}
      hidden={!active}
      style={active ? undefined : { display: 'none' }}
    >
      <div className="collaboration-project-create-configuration-body">{children}</div>
      <footer className="collaboration-project-create-footer">
        <button
          type="button"
          data-testid="collaboration-project-create-configuration-back"
          onClick={onBack}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </button>
        {footer}
      </footer>
    </section>
  )
}
