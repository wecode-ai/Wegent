// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { CollaborationGroup } from '../types'
import type { CollaborationLocale } from '../i18n'
import { useCollaborationTemplateStore } from './context'
import { templateFromProject, exportTemplate } from './document'
import { templateMessages } from './messages'
import { TemplateSaveDialog } from './TemplateSaveDialog'
import type { CollaborationTemplate } from './types'

export function GroupTemplateActions({
  group,
  locale,
}: {
  group: CollaborationGroup
  locale: CollaborationLocale
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [saving, setSaving] = useState<CollaborationTemplate | null>(null)
  if (!store) return null
  const snapshot = () =>
    templateFromProject(
      { name: group.name, description: group.description },
      [group],
      `template-${crypto.randomUUID()}`,
      locale
    )
  return (
    <section className="collaboration-template-settings" data-testid="group-template-settings">
      <h3>{m.configuration}</h3>
      <p>{m.saveHint}</p>
      <button
        type="button"
        className="collaboration-template-choice"
        data-testid="group-template-save"
        onClick={() => setSaving(snapshot())}
      >
        {m.saveTitle}
      </button>
      <section>
        <p>{m.exportHint}</p>
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="group-template-export"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([exportTemplate(snapshot())], {
                type: 'application/yaml;charset=utf-8',
              })
            )
            const link = document.createElement('a')
            link.href = url
            link.download = 'collaboration-group-template.yaml'
            link.click()
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
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
