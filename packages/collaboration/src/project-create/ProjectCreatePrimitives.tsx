// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowRight, LoaderCircle, X } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useDialogKeyboard } from '../controls/useDialogKeyboard'
import type { ProjectCreateModalProps } from './types'

export function DefaultModal({ title, closeLabel, children, onClose }: ProjectCreateModalProps) {
  const titleId = useId()
  const dialogRef = useDialogKeyboard<HTMLElement>(onClose)
  return (
    <div className="collaboration-dialog-backdrop">
      <section
        ref={dialogRef}
        className="collaboration-dialog collaboration-project-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="collaboration-project-create-dialog"
      >
        <header className="collaboration-project-create-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            data-testid="collaboration-project-create-close"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
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
    <button
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
    </button>
  )
}

export function CollaboratorToken({
  icon,
  label,
  onRemove,
  removeLabel,
}: {
  icon: ReactNode
  label: string
  onRemove?: () => void
  removeLabel?: string
}) {
  return (
    <span className="collaboration-project-create-collaborator-token">
      {icon}
      <span>{label}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={removeLabel}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </span>
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
