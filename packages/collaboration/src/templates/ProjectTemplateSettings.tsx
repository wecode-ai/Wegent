// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'
import { normalizeCollaborationGroupDraftForPersistence } from '../project-create/collaborationGroupDraft'
import { useCollaborationTemplateStore } from './context'
import { exportTemplate, templateFromProject } from './document'
import { templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { TemplateBindingsDialog, type TemplateParticipant } from './TemplateBindings'
import { TemplateSaveDialog } from './TemplateSaveDialog'
import type { CollaborationTemplate } from './types'
import { applyTemplateGroups } from './apply'

export function ProjectTemplateSettings({
  api,
  project,
  locale,
  currentUserId,
  canManage,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  locale: CollaborationLocale
  currentUserId?: number
  canManage: boolean
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [groups, setGroups] = useState<CollaborationGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [candidates, setCandidates] = useState<TemplateParticipant[]>([])
  const [selected, setSelected] = useState<CollaborationTemplate | null>(null)
  const [saving, setSaving] = useState<CollaborationTemplate | null>(null)
  const scope = useRef(0)
  const reload = useCallback(async () => {
    const generation = ++scope.current
    setLoading(true)
    try {
      const result = (await api.projects.listCollaborationGroups?.(project.id)) ?? []
      if (scope.current === generation) {
        setGroups(result)
        setError(null)
      }
    } catch {
      if (scope.current === generation) setError(m.failed)
    } finally {
      if (scope.current === generation) setLoading(false)
    }
  }, [api, project.id, m.failed])
  useEffect(() => {
    setGroups([])
    void reload()
    return () => {
      scope.current++
    }
  }, [reload])
  if (!store) return null
  const snapshot = () =>
    templateFromProject(project, groups, `template-${crypto.randomUUID()}`, locale)
  return (
    <section className="collaboration-template-settings" data-testid="project-template-settings">
      <h2>{m.configuration}</h2>
      <p>{m.configurationHint}</p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" data-testid="project-template-retry" onClick={() => void reload()}>
            {m.retry}
          </button>
        </p>
      )}
      {canManage && api.projects.createCollaborationGroup && (
        <section>
          <h3>{m.importProject}</h3>
          <p>{m.importProjectHint}</p>
          <button
            type="button"
            className="collaboration-template-choice"
            data-testid="project-template-import"
            disabled={loading || !!error}
            onClick={async () => {
              const generation = scope.current
              setLoading(true)
              try {
                const [members, agents] = await Promise.all([
                  api.members.list(project.id),
                  api.agents.list(project.id),
                ])
                if (scope.current !== generation) return
                setCandidates([
                  ...members.map(member => ({
                    kind: 'human' as const,
                    id: String(member.user_id),
                    name: member.user_name,
                    label: member.user_name,
                    responsibility: '',
                  })),
                  ...agents.map(agent => ({
                    kind: 'agent' as const,
                    id: String(agent.team_id ?? agent.id),
                    name: agent.name,
                    label: agent.name,
                    responsibility: '',
                  })),
                ])
                setChoosing(true)
              } catch {
                if (scope.current === generation) setError(m.failed)
              } finally {
                if (scope.current === generation) setLoading(false)
              }
            }}
          >
            {m.importProject}
          </button>
        </section>
      )}
      <section>
        <h3>{m.saveTitle}</h3>
        <p>{m.saveHint}</p>
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="project-template-save"
          disabled={loading || !!error}
          onClick={() => setSaving(snapshot())}
        >
          {m.saveTitle}
        </button>
      </section>
      <section>
        <h3>{m.export}</h3>
        <p>{m.exportHint}</p>
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="project-template-export"
          disabled={loading || !!error}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([exportTemplate(snapshot())], {
                type: 'application/yaml;charset=utf-8',
              })
            )
            const link = document.createElement('a')
            link.href = url
            link.download = 'collaboration-template.yaml'
            link.click()
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
          }}
        >
          {m.export}
        </button>
      </section>
      {choosing && (
        <TemplateDialog
          title={m.importTitle}
          closeLabel={m.close}
          onClose={() => setChoosing(false)}
        >
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
          existingNames={groups.map(group => group.name)}
          onClose={() => {
            setSelected(null)
            void reload()
          }}
          onApply={async drafts => {
            await applyTemplateGroups(
              drafts,
              raw => {
                const draft = normalizeCollaborationGroupDraftForPersistence(raw)
                return api.projects.createCollaborationGroup!(project.id, {
                  ...draft,
                  coordinationMode: 'manager',
                })
              },
              m.partial
            )
            await reload()
          }}
        />
      )}
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
