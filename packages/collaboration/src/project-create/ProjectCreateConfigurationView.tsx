import { useOwnedFocusTarget } from '../dom-events'
import { ArrowLeft } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
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
  useOwnedFocusTarget(ref, focusTarget, active)
  return (
    <InlinePanel
      ref={ref}
      onEscape={onBack}
      active={active}
      initialFocus={focusTarget === undefined ? undefined : null}
      restoreFocus={restoreFocus}
      aria-label={focusLabel}
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
