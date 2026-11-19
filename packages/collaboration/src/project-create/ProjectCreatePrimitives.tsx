import { useRef } from 'react'
import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowRight, LoaderCircle, X } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { ProjectCreateModalProps } from './types'

export function DefaultModal({ title, closeLabel, children, onClose }: ProjectCreateModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const lastDialogFocus = useRef<HTMLElement | null>(null)
  return (
    <div className="collaboration-dialog-backdrop">
      <DialogSurface
        onClose={onClose}
        initialFocus={() => {
          const dialog = dialogRef.current
          const focused = dialog?.ownerDocument.activeElement
          if (
            focused instanceof HTMLElement &&
            focused !== dialog &&
            dialog?.contains(focused) &&
            !focused.closest('[hidden], [inert]')
          )
            return focused
          const previous = lastDialogFocus.current
          if (
            previous?.isConnected &&
            dialog?.contains(previous) &&
            !previous.closest('[hidden], [inert]') &&
            !previous.matches(':disabled')
          )
            return previous
          return dialog?.querySelector<HTMLElement>('input[required]:not([disabled])') ?? null
        }}
        render={
          <section
            ref={dialogRef}
            onFocusCapture={event => {
              if (event.target instanceof HTMLElement) lastDialogFocus.current = event.target
            }}
            className="collaboration-dialog collaboration-project-create-dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            data-testid="collaboration-project-create-dialog"
          />
        }
      >
        <header className="collaboration-project-create-header">
          <h2 id={titleId}>{title}</h2>
          <ControlButton
            variant="unstyled"
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            showTooltip={false}
            data-testid="collaboration-project-create-close"
          >
            <X aria-hidden="true" />
          </ControlButton>
        </header>
        {children}
      </DialogSurface>
    </div>
  )
}

export function ChoiceButton({
  testId,
  selected,
  icon,
  label,
  description,
  onClick,
  compact = false,
}: {
  testId: string
  selected: boolean
  icon: ReactNode
  label: string
  description: string
  onClick(): void
  compact?: boolean
}) {
  return (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
      className={`collaboration-project-create-choice${compact ? ' is-compact' : ''}${selected ? ' is-selected' : ''}`}
    >
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </ControlButton>
  )
}

export function CollaborationGroupWorkflow({
  label,
  pendingLabel,
  stages,
  generating = false,
}: {
  label: string
  pendingLabel: string
  stages: Array<{ id: string; name: string }>
  generating?: boolean
}) {
  return (
    <div
      className={`collaboration-project-create-group-workflow${generating ? ' is-generating' : ''}`}
      data-testid={generating ? 'collaboration-project-create-generation-workflow' : undefined}
    >
      <small>{label}</small>
      {stages.length > 0 ? (
        <div>
          {stages.map((stage, index) => (
            <span key={stage.id}>
              <strong>{stage.name}</strong>
              {index < stages.length - 1 ? <ArrowRight aria-hidden="true" /> : null}
            </span>
          ))}
        </div>
      ) : generating ? (
        <span className="collaboration-project-create-workflow-pending">
          <LoaderCircle aria-hidden="true" className="collaboration-spin" />
          {pendingLabel}
        </span>
      ) : null}
    </div>
  )
}
