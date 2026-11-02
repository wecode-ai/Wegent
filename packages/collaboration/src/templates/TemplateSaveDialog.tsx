// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { CollaborationLocale } from '../i18n'
import type { CollaborationTemplate, TemplateRecord } from './types'
import type { CollaborationTemplateStore } from './store'
import { templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { TemplatePreview } from './TemplatePreview'

export function TemplateSaveDialog({
  document,
  store,
  locale,
  onClose,
}: {
  document: CollaborationTemplate
  store: CollaborationTemplateStore
  locale: CollaborationLocale
  onClose(): void
}) {
  const m = templateMessages[locale]
  const [name, setName] = useState(document.spec.displayName)
  const [description, setDescription] = useState(document.spec.description)
  const [saved, setSaved] = useState<TemplateRecord | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <TemplateDialog
      title={saved ? (publishing ? m.publishTitle : m.saved) : m.saveTitle}
      description={publishing ? m.publishHint : m.saveHint}
      closeLabel={m.close}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" data-testid="template-save-close" disabled={busy} onClick={onClose}>
            {m.close}
          </button>
          {!saved ? (
            <button
              type="button"
              className="collaboration-primary-button"
              data-testid="template-save-confirm"
              disabled={busy || !name.trim()}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  setSaved(
                    await store.save(
                      {
                        ...document,
                        metadata: {
                          name: `template-${crypto.randomUUID()}`,
                          namespace: 'default',
                        },
                        spec: {
                          ...document.spec,
                          displayName: name.trim(),
                          description,
                        },
                      },
                      store.library.ownerId
                    )
                  )
                } catch {
                  setError(m.failed)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? m.saving : m.save}
            </button>
          ) : (
            !published && (
              <button
                type="button"
                className="collaboration-primary-button"
                data-testid="template-publish"
                disabled={busy || saved.pendingSync || !saved.id || !store.library.remote}
                onClick={async () => {
                  if (!publishing) {
                    setPublishing(true)
                    return
                  }
                  setBusy(true)
                  setError(null)
                  try {
                    await store.library.remote!.publish(saved.id!, saved.document.spec.version)
                    setPublished(true)
                  } catch {
                    setError(m.failed)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {publishing ? m.publishConfirm : m.publish}
              </button>
            )
          )}
        </>
      }
    >
      {!saved ? (
        <>
          <label className="collaboration-template-field">
            <span>{m.saveName}</span>
            <input
              data-testid="template-save-name"
              disabled={busy}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className="collaboration-template-field">
            <span>{m.descriptionLabel}</span>
            <textarea
              data-testid="template-save-description"
              disabled={busy}
              value={description}
              onChange={event => setDescription(event.target.value)}
              rows={3}
            />
          </label>
        </>
      ) : (
        <p className="collaboration-template-notice" role="status">
          {published
            ? m.published
            : publishing
              ? m.publishScope
              : saved.pendingSync
                ? m.saveOffline
                : m.saveOnline}
        </p>
      )}
      {saved?.syncError && <p role="alert">{m.syncConflict}</p>}
      {error && (
        <p role="alert" className="collaboration-template-error">
          {error}
        </p>
      )}
      <TemplatePreview document={saved?.document ?? document} locale={locale} />
    </TemplateDialog>
  )
}
