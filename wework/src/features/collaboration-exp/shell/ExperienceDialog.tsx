import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { X } from 'lucide-react'
import { useId, useRef, type ReactNode } from 'react'
import './ExperienceDialog.css'

interface Props {
  testId: string
  title: string
  subtitle: string
  closeLabel: string
  onClose(): void
  children: ReactNode
}

/** Source dialog presentation with the workbench's existing keyboard lifecycle. */
export function ExperienceDialog({
  testId,
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
}: Props) {
  const titleId = useId()
  const subtitleId = useId()
  const ref = useRef<HTMLElement>(null)
  return (
    <div className="experience-dialog-scrim">
      <DialogSurface
        onClose={onClose}
        render={
          <section
            ref={ref}
            className="experience-dialog"
            data-size="md"
            data-testid={testId}
            aria-labelledby={titleId}
            aria-describedby={subtitleId}
            tabIndex={-1}
          />
        }
      >
        <header className="experience-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={subtitleId}>{subtitle}</p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            className="experience-dialog-close"
            data-testid={`${testId}-close`}
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </ControlButton>
        </header>
        <div className="experience-dialog-body">{children}</div>
      </DialogSurface>
    </div>
  )
}
