import { DialogSurface } from '../controls/DialogSurface'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { TextField as ControlInput } from '../controls/TextField'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'

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
  const dialogRef = useRef<HTMLDivElement>(null)
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
    <DialogSurface
      inline={false}
      onClose={() => {
        if (!submittingRef.current) onClose()
      }}
      render={
        <div
          ref={dialogRef}
          className="collaboration-dialog collaboration-workspace-create-dialog"
          aria-label={messages.createWorkspace}
          aria-busy={saving}
        />
      }
    >
      <h2>{messages.createWorkspace}</h2>
      <p className="collaboration-workspace-storage-notice">{messages.cloudStorageNotice}</p>
      <label>
        {messages.name}
        <ControlInput
          data-testid="collaboration-workspace-name-input"
          value={name}
          disabled={saving}
          onChange={event => {
            setName(event.target.value)
            setError(null)
          }}
        />
      </label>
      <label>
        {messages.description}
        <ControlTextarea
          data-testid="collaboration-workspace-description-input"
          value={description}
          disabled={saving}
          onChange={event => {
            setDescription(event.target.value)
            setError(null)
          }}
        />
      </label>
      <label>
        {messages.owner}
        <SelectRoot
          disabled={saving}
          onValueChange={selectedValue => {
            if (selectedValue === null) return
            setNamespace(selectedValue)
            setError(null)
          }}
          value={normalizeSelectValue(namespace)}
        >
          <SelectTrigger
            data-testid="collaboration-workspace-owner-select"
            aria-label={messages.owner}
            data-value={namespace}
          />
          <SelectContent>
            {effectiveOwnerOptions.map(option => (
              <SelectItem key={option.namespace} value={String(option.namespace)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
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
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="collaboration-workspace-create-cancel"
          disabled={saving}
          onClick={onClose}
        >
          {messages.cancel}
        </ControlButton>
        <ControlButton
          variant="unstyled"
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
        </ControlButton>
      </footer>
    </DialogSurface>
  )
}
