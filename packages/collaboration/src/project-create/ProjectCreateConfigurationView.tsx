import { keepFocus } from '@ui-sdk/core'
import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { InlinePanel } from '../controls/InlinePanel'
import { Button as ControlButton } from '../markdown/Button'

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
  const ref = useRef<HTMLElement>(null)
  const lastOwnedFocus = useRef<HTMLElement | null>(null)
  const restoreLostFocus = useCallback(() => {
    const section = ref.current
    if (!active || !section) return
    const current = document.activeElement
    const removedControlLostFocus =
      (current === document.body || current === null) &&
      lastOwnedFocus.current !== null &&
      !lastOwnedFocus.current.isConnected
    if (current !== section && !removedControlLostFocus) return
    const requested =
      focusTarget === undefined
        ? (section.querySelector<HTMLElement>('[contenteditable="true"]:not([tabindex="-1"])') ??
          section.querySelector<HTMLElement>(
            'input:not([disabled]), textarea:not([disabled]), [role="combobox"]:not([disabled])'
          ) ??
          section.querySelector<HTMLElement>('button:not([disabled])'))
        : focusTarget === null
          ? null
          : section.querySelector<HTMLElement>(focusTarget)
    const target =
      requested && !requested.closest('[hidden], [inert]') && !requested.matches(':disabled')
        ? requested
        : section
    if (current !== target) {
      target.focus()
      if (document.activeElement !== target)
        keepFocus(() => (target.isConnected ? target : undefined))
    }
  }, [active, focusTarget, ref])
  useLayoutEffect(restoreLostFocus, [restoreLostFocus])
  // ProseMirror creates its editable DOM in a child passive effect.
  useEffect(restoreLostFocus, [restoreLostFocus])
  return (
    <InlinePanel
      ref={ref}
      onEscape={onBack}
      active={active}
      restoreFocus={restoreFocus}
      aria-label={focusLabel}
      onFocusCapture={event => {
        if (event.target instanceof HTMLElement && ref.current?.contains(event.target))
          lastOwnedFocus.current = event.target
      }}
      className="collaboration-project-create-configuration"
      data-testid={testId}
    >
      <div className="collaboration-project-create-configuration-body">{children}</div>
      <footer className="collaboration-project-create-footer">
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="collaboration-project-create-configuration-back"
          onClick={onBack}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </ControlButton>
        {footer}
      </footer>
    </InlinePanel>
  )
}
