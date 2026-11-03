// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { CollaborationLocale } from '../i18n'
import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateResourceSetup,
} from '../project-create/types'
import type { CollaborationTemplate } from './types'
import { useCollaborationTemplateStore } from './context'
import { templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { TemplateBindings } from './TemplateBindings'

export function TemplateCreateSection({
  setup,
  locale,
  initialTemplate,
  disabled,
  onSelect,
  onChange,
}: {
  setup: ProjectCreateResourceSetup
  locale: CollaborationLocale
  initialTemplate?: CollaborationTemplate | null
  disabled?: boolean
  onSelect(document: CollaborationTemplate | null): void
  onChange(drafts: ProjectCreateCollaborationGroupDraft[] | null, selected: boolean): void
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [document, setDocument] = useState(initialTemplate ?? null)
  const [open, setOpen] = useState(false)
  if (!store) return null
  const members = [
    { user_id: setup.currentUser.id, user_name: setup.currentUser.name },
    ...setup.members.filter(member => member.user_id !== setup.currentUser.id),
  ]
  return (
    <section
      className="collaboration-template-create-section"
      data-testid="project-create-template-section"
    >
      <div className="collaboration-template-page-heading">
        <h3>{document ? `${m.selected} · ${document.spec.displayName}` : m.title}</h3>
        <div className="collaboration-template-actions">
          <button
            type="button"
            className="collaboration-template-choice"
            data-testid="project-create-choose-template"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            {m.discover}
          </button>
          {document && (
            <button
              type="button"
              className="collaboration-template-choice"
              data-testid="project-create-clear-template"
              disabled={disabled}
              onClick={() => {
                setDocument(null)
                onSelect(null)
                onChange([], false)
              }}
            >
              {m.clearSelection}
            </button>
          )}
        </div>
      </div>
      {document && (
        <TemplateBindings
          key={`${document.metadata.name}:${document.spec.version}`}
          document={document}
          locale={locale}
          disabled={disabled}
          currentUserId={setup.currentUser.id}
          candidates={[
            ...members.map(member => ({
              kind: 'human' as const,
              id: String(member.user_id),
              name: member.user_name,
              label: member.user_name,
              responsibility: '',
            })),
            ...setup.agents.map(agent => ({
              kind: 'agent' as const,
              id: agent.id,
              name: agent.name,
              label: agent.name,
              responsibility: '',
            })),
          ]}
          onChange={drafts => onChange(drafts, true)}
        />
      )}
      {open && (
        <TemplateDialog title={m.title} closeLabel={m.close} onClose={() => setOpen(false)}>
          <CollaborationTemplatePage
            store={store}
            locale={locale}
            onUse={record => {
              setDocument(record.document)
              onChange(null, true)
              onSelect(record.document)
              setOpen(false)
            }}
          />
        </TemplateDialog>
      )}
    </section>
  )
}
