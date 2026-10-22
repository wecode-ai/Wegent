// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react'

export interface AgentDeleteAction {
  name: string
  labels: {
    cancel: string
    confirm: string
    description: string
    failed: string
    pending: string
  }
  onDelete(): Promise<void>
}

export function AgentDeleteDialog({
  action,
  onClose,
}: {
  action: AgentDeleteAction
  onClose(): void
}) {
  const dialog = useRef<HTMLElement>(null)
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (pending) dialog.current?.focus()
  }, [pending])

  async function remove() {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    try {
      await action.onDelete()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action.labels.failed)
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 p-3 md:p-5"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !lock.current) onClose()
      }}
    >
      <section
        aria-busy={pending}
        aria-label={action.labels.confirm}
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-border bg-popover p-6 text-text-primary shadow-lg"
        data-testid="collaboration-delete-agent-dialog"
        ref={dialog}
        role="dialog"
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (!lock.current) onClose()
          }
          if (event.key !== 'Tab') return
          const buttons = Array.from(
            dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
          )
          const first = buttons[0]
          const last = buttons[buttons.length - 1]
          if (!first || !last) {
            event.preventDefault()
          } else if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === dialog.current)
          ) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <h2 className="text-heading-sm font-medium">{action.labels.confirm}</h2>
        <p className="mt-3 break-words font-medium">{action.name}</p>
        <p className="mt-2 text-sm text-text-secondary">{action.labels.description}</p>
        {error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <button
            className="min-h-11 rounded-lg px-4 text-sm hover:bg-muted disabled:opacity-40 md:min-h-8"
            data-testid="collaboration-delete-agent-cancel"
            disabled={pending}
            onClick={() => {
              if (!lock.current) onClose()
            }}
            type="button"
          >
            {action.labels.cancel}
          </button>
          <button
            className="min-h-11 rounded-lg bg-destructive px-4 text-sm text-white disabled:opacity-40 md:min-h-8"
            data-testid="collaboration-delete-agent-confirm"
            disabled={pending}
            onClick={() => void remove()}
            type="button"
          >
            {pending ? action.labels.pending : action.labels.confirm}
          </button>
        </div>
      </section>
    </div>
  )
}
