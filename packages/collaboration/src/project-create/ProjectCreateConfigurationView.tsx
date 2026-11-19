import type { ReactNode } from 'react'
import { useOwnedFocusTarget } from '../dom-events'
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
  useOwnedFocusTarget(ref, focusTarget, active)
  return (
    <section
      ref={ref}
      aria-label={focusLabel}
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
