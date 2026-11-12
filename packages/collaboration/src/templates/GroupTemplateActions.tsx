// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { CollaborationGroup } from '../types'
import type { CollaborationLocale } from '../i18n'
import { useCollaborationTemplateStore } from './context'
import { templateFromProject, downloadTemplate } from './document'
import { templateFailureMessage, templateMessages } from './messages'
import { TemplateSaveDialog } from './TemplateSaveDialog'
import type { CollaborationTemplate } from './types'

export function GroupTemplateActions({
  group,
  locale,
  loadAgents,
}: {
  group: CollaborationGroup
  locale: CollaborationLocale
  loadAgents(
    group: CollaborationGroup
  ): Promise<import('../ports/SharedWorkspaceApi').WorkspaceProjectAgent[]>
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [saving, setSaving] = useState<CollaborationTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!store) return null
  const snapshot = async () =>
    templateFromProject(
      { name: group.name, description: group.description },
      [group],
      `template-${crypto.randomUUID()}`,
      locale,
      await loadAgents(group)
    )
  return (
    <section className="collaboration-template-settings" data-testid="group-template-settings">
      <h3>{m.configuration}</h3>
      <p>{m.saveHint}</p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="collaboration-template-choice"
        data-testid="group-template-save"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            setSaving(await snapshot())
          } catch (error) {
            setError(templateFailureMessage(error, locale))
          } finally {
            setBusy(false)
          }
        }}
      >
        {m.saveTitle}
      </button>
      <section>
        <p>{m.exportHint}</p>
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="group-template-export"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              downloadTemplate(await snapshot(), 'collaboration-group-template.yaml')
            } catch (error) {
              setError(templateFailureMessage(error, locale))
            } finally {
              setBusy(false)
            }
          }}
        >
          {m.export}
        </button>
      </section>
      {saving && (
        <TemplateSaveDialog
          document={saving}
          store={store}
          locale={locale}
          onClose={() => setSaving(null)}
        />
      )}
    </section>
  )
}
