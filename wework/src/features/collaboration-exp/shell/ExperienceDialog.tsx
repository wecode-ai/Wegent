import { useId, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
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
  const ref = useDialogKeyboard<HTMLElement>(onClose)
  return (
    <div className="experience-dialog-scrim">
      <section
        ref={ref}
        className="experience-dialog"
        data-size="md"
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
      >
        <header className="experience-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={subtitleId}>{subtitle}</p>
          </div>
          <button
            type="button"
            className="experience-dialog-close"
            data-testid={`${testId}-close`}
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="experience-dialog-body">{children}</div>
      </section>
    </div>
  )
}
