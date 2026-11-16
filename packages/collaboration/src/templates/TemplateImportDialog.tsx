// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react'
import type { CollaborationLocale } from '../i18n'
import { importTemplate } from './document'
import { templateMessages } from './messages'
import type { CollaborationTemplate } from './types'
import type { CollaborationTemplateStore } from './store'
import { TemplateDialog } from './TemplateDialog'
import { TemplatePreview } from './TemplatePreview'

export function TemplateImportDialog({
  store,
  locale,
  onClose,
  onSaved,
}: {
  store: CollaborationTemplateStore
  locale: CollaborationLocale
  onClose(): void
  onSaved(document: CollaborationTemplate): void
}) {
  const m = templateMessages[locale]
  const [document, setDocument] = useState<CollaborationTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const readVersion = useRef(0)
  return (
    <TemplateDialog
      title={m.importTitle}
      description={m.importHint}
      closeLabel={m.close}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button
            type="button"
            disabled={busy}
            data-testid="template-import-cancel"
            onClick={onClose}
          >
            {m.cancel}
          </button>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="template-import-save"
            disabled={!document || busy}
            onClick={async () => {
              if (!document) return
              setBusy(true)
              try {
                await store.save(document, store.library.ownerId)
                onSaved(document)
              } catch {
                setError(m.failed)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? m.saving : m.save}
          </button>
        </>
      }
    >
      <label className="collaboration-template-field">
        <span>{m.file}</span>
        <input
          type="file"
          accept=".yaml,.yml"
          data-testid="template-import-file"
          disabled={busy}
          onChange={async event => {
            const file = event.target.files?.[0]
            const version = ++readVersion.current
            setDocument(null)
            setError(null)
            if (!file) return
            if (file.size > 1024 * 1024) {
              setError(m.sizeLimit)
              return
            }
            try {
              const parsed = importTemplate(await file.text())
              if (version !== readVersion.current) return
              parsed.metadata = {
                name: `template-${crypto.randomUUID()}`,
                namespace: 'default',
              }
              setDocument(parsed)
            } catch {
              if (version === readVersion.current) setError(m.invalid)
            }
          }}
        />
        <small>{m.sizeLimit}</small>
      </label>
      {error && (
        <p role="alert" className="collaboration-template-error">
          {error}
        </p>
      )}
      {document && <TemplatePreview document={document} locale={locale} />}
    </TemplateDialog>
  )
}
