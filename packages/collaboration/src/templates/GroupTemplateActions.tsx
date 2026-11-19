import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { CollaborationLocale } from '../i18n'
import type { CollaborationGroup } from '../types'
import { useCollaborationTemplateStore } from './context'
import { downloadTemplate, templateFromProject } from './document'
import { templateFailureMessage, templateMessages } from './messages'
import { TemplateSaveDialog } from './TemplateSaveDialog'
import type { CollaborationTemplate } from './types'

export function GroupTemplateActions({
  group,
  locale,
  loadAgents,
  hasUnsavedChanges = false,
}: {
  group: CollaborationGroup
  hasUnsavedChanges?: boolean
  locale: CollaborationLocale
  loadAgents(
    group: CollaborationGroup
  ): Promise<import('../ports/SharedWorkspaceApi').WorkspaceProjectAgent[]>
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const savedConfigurationHint =
    locale === 'zh-CN'
      ? '此模板使用小组已保存的配置，不包含未保存的更改。'
      : 'This template uses the group’s saved configuration and excludes unsaved changes.'
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
    <section className="space-y-3 text-sm" data-testid="group-template-settings">
      <p className="text-text-secondary">{savedConfigurationHint}</p>
      {hasUnsavedChanges ? (
        <p
          className="text-sm text-text-secondary"
          role="note"
          data-testid="group-template-saved-version-hint"
        >
          {locale === 'zh-CN'
            ? '当前有未保存的更改。此处使用上次保存的版本；若要包含这些更改，请先保存小组。'
            : 'There are unsaved changes. Sharing uses the last saved version; save the group first to include these changes.'}
        </p>
      ) : null}
      {error && <p role="alert">{error}</p>}
      <ControlButton
        variant="unstyled"
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
      </ControlButton>
      <section className="space-y-2 border-t border-border pt-3">
        <p className="text-text-secondary">{m.exportHint}</p>
        <ControlButton
          variant="unstyled"
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
        </ControlButton>
      </section>
      {saving && (
        <TemplateSaveDialog
          document={saving}
          sourceDescription={savedConfigurationHint}
          store={store}
          locale={locale}
          onClose={() => setSaving(null)}
        />
      )}
    </section>
  )
}
