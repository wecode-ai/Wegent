// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { CollaborationLocale } from '../i18n'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import { useCollaborationTemplateStore } from './context'
import { templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { TemplateBindingsDialog, type TemplateParticipant } from './TemplateBindings'
import type { CollaborationTemplate } from './types'

export function GroupTemplateCreator({
  locale,
  candidates,
  currentUserId,
  existingNames,
  onApply,
  disabled,
}: {
  locale: CollaborationLocale
  candidates: TemplateParticipant[]
  currentUserId?: number
  existingNames: string[]
  disabled?: boolean
  onApply(drafts: ProjectCreateCollaborationGroupDraft[]): Promise<void>
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [choosing, setChoosing] = useState(false)
  const [selected, setSelected] = useState<CollaborationTemplate | null>(null)
  if (!store) return null
  return (
    <>
      <button
        type="button"
        className="collaboration-template-choice"
        data-testid="group-template-create"
        disabled={disabled}
        onClick={() => setChoosing(true)}
      >
        {m.createFromTemplate}
      </button>
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
        />
      )}
    </>
  )
}
