// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

interface WorkspaceCreateMessages {
  createWorkspace: string
  creatingWorkspace: string
  createWorkspaceFailed: string
  cloudStorageNotice: string
  name: string
  description: string
  owner: string
  personalOwner: string
  ownerHint: string
  cancel: string
}

export function WorkspaceCreateDialog({
  messages,
  ownerOptions,
  onClose,
  onCreate,
}: {
  messages: WorkspaceCreateMessages
  ownerOptions?: Array<{ label: string; namespace: string }>
  onClose(): void
  onCreate(input: { name: string; description?: string; namespace?: string }): Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [namespace, setNamespace] = useState('default')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const effectiveOwnerOptions = ownerOptions ?? [
    { label: messages.personalOwner, namespace: 'default' },
  ]

  async function submit() {
    if (submittingRef.current || !name.trim()) return
    submittingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        namespace,
      })
    } catch (error) {
      setError(
        error instanceof Error && error.message ? error.message : messages.createWorkspaceFailed
      )
    } finally {
      submittingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-workspace-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.createWorkspace}
        aria-busy={saving}
      >
        <h2>{messages.createWorkspace}</h2>
        <p className="collaboration-workspace-storage-notice">{messages.cloudStorageNotice}</p>
        <label>
          {messages.name}
          <input
            autoFocus
            data-testid="collaboration-workspace-name-input"
            value={name}
            disabled={saving}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label>
          {messages.description}
          <textarea
            data-testid="collaboration-workspace-description-input"
            value={description}
            disabled={saving}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        <label>
          {messages.owner}
          <select
            data-testid="collaboration-workspace-owner-select"
            disabled={saving}
            onChange={event => setNamespace(event.target.value)}
            value={namespace}
          >
            {effectiveOwnerOptions.map(option => (
              <option key={option.namespace} value={option.namespace}>
                {option.label}
              </option>
            ))}
          </select>
          <small>{messages.ownerHint}</small>
        </label>
        {error ? (
          <p
            className="collaboration-alert"
            role="alert"
            data-testid="collaboration-workspace-create-error"
          >
            {error}
          </p>
        ) : null}
        <footer>
          <button
            type="button"
            data-testid="collaboration-workspace-create-cancel"
            disabled={saving}
            onClick={onClose}
          >
            {messages.cancel}
          </button>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="collaboration-workspace-create-confirm"
            disabled={saving || !name.trim()}
            onClick={() => void submit()}
          >
            {saving ? (
              <span role="status" className="inline-flex items-center gap-2">
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {messages.creatingWorkspace}
              </span>
            ) : (
              messages.createWorkspace
            )}
          </button>
        </footer>
      </section>
    </div>
  )
}
