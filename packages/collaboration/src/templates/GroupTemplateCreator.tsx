import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { CollaborationLocale } from '../i18n'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { useCollaborationTemplateStore } from './context'
import { templateMessages } from './messages'
import { TemplateBindingsDialog, type TemplateParticipant } from './TemplateBindings'
import { TemplateDialog } from './TemplateDialog'
import type { TemplateModelConfiguration } from './TemplateModelSelection'
import type { CollaborationTemplate, TemplateRoutingResolver } from './types'

export function GroupTemplateCreator({
  locale,
  candidates,
  currentUserId,
  existingNames,
  onApply,
  disabled,
  modelConfiguration,
}: {
  locale: CollaborationLocale
  candidates: TemplateParticipant[]
  currentUserId?: number
  existingNames: string[]
  disabled?: boolean
  modelConfiguration?: TemplateModelConfiguration
  onApply(
    drafts: ProjectCreateCollaborationGroupDraft[],
    document: CollaborationTemplate,
    resolveRouting?: TemplateRoutingResolver
  ): Promise<void>
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [choosing, setChoosing] = useState(false)
  const [selected, setSelected] = useState<CollaborationTemplate | null>(null)
  if (!store) return null
  return (
    <>
      <ControlButton
        variant="unstyled"
        type="button"
        className="collaboration-template-choice"
        data-testid="group-template-create"
        disabled={disabled}
        onClick={() => setChoosing(true)}
      >
        {m.createFromTemplate}
      </ControlButton>
      {choosing && (
        <TemplateDialog title={m.title} closeLabel={m.close} onClose={() => setChoosing(false)}>
          <CollaborationTemplatePage
            store={store}
            locale={locale}
            onUse={record => {
              setSelected(record.document)
              setChoosing(false)
            }}
          />
        </TemplateDialog>
      )}
      {selected && (
        <TemplateBindingsDialog
          document={selected}
          locale={locale}
          candidates={candidates}
          currentUserId={currentUserId}
          existingNames={existingNames}
          onClose={() => setSelected(null)}
          onApply={onApply}
          modelConfiguration={modelConfiguration}
        />
      )}
    </>
  )
}
