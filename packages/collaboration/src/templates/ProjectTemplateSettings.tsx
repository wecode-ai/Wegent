// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'
import { useCollaborationTemplateStore } from './context'
import { downloadTemplate, templateFromProject } from './document'
import { templateFailureMessage, templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { ProjectTemplateApplyDialog } from './ProjectTemplateApplyDialog'
import { TemplateSaveDialog } from './TemplateSaveDialog'
import type { CollaborationTemplate } from './types'
import { readTemplateAgents } from './agents'
import { ProjectSettingsPage } from '../project-manage/ProjectSettingsPage'

export function ProjectTemplateSettings({
  api,
  agentConfiguration,
  project,
  locale,
  currentUserId,
  canManage,
  onChange,
}: {
  api: SharedWorkspaceApi
  agentConfiguration?: import('../project-agent-config/types').ProjectAgentConfigurationHost
  project: CollaborationProject
  locale: CollaborationLocale
  currentUserId?: number
  canManage: boolean
  onChange?(project: CollaborationProject): void
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const projectId = project.id
  const projectStore = project.project_store
  const resource = useMemo(
    () =>
      createAsyncResource(
        `${projectStore}:${projectId}`,
        async () => {
          const [groups, latest, rules] = await Promise.all([
            api.projects.listCollaborationGroups?.(projectId) ?? Promise.resolve([]),
            api.projects.get(projectId),
            api.automations?.list(projectId) ?? Promise.resolve([]),
          ])
          return { groups, project: { ...latest, automatic_processing_rules: rules } }
        },
        { refreshOnSubscribe: true }
      ),
    [api, projectId, projectStore]
  )
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [selected, setSelected] = useState<CollaborationTemplate | null>(null)
  const [saving, setSaving] = useState<CollaborationTemplate | null>(null)
  const [selectionScope, setSelectionScope] = useState(resource)
  if (selectionScope !== resource) {
    setSelectionScope(resource)
    setBusy(false)
    setFailure(null)
    setChoosing(false)
    setSelected(null)
    setSaving(null)
  }
  const groups = state.data?.groups ?? []
  const configurationProject = state.data?.project ?? project
  const loading = busy || state.status === 'idle' || state.status === 'loading'
  const error = failure
    ? templateFailureMessage(failure.error, locale)
    : state.status === 'error'
      ? m.failed
      : null
  const reload = () => {
    setFailure(null)
    return resource.reload()
  }
  if (!store) return null
  const snapshot = async () =>
    templateFromProject(
      configurationProject,
      groups,
      `template-${crypto.randomUUID()}`,
      locale,
      await readTemplateAgents(
        await api.agents.list(project.id, { forceRefresh: true }),
        groups,
        agentConfiguration?.readTemplateAgent
      )
    )
  return (
    <ProjectSettingsPage
      title={m.configuration}
      description={m.configurationHint}
      testId="project-template-settings"
    >
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" data-testid="project-template-retry" onClick={() => void reload()}>
            {m.retry}
          </button>
        </p>
      )}
      {canManage && api.projects.createCollaborationGroup && (
        <section className="flex flex-wrap items-start justify-between gap-4 border-b border-border py-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium">{m.importProject}</h2>
            <p className="mt-1 text-sm text-text-secondary">{m.importProjectHint}</p>
          </div>
          <button
            type="button"
            className="collaboration-template-choice"
            data-testid="project-template-import"
            disabled={loading || !!error}
            onClick={() => setChoosing(true)}
          >
            {m.chooseTemplate}
          </button>
        </section>
      )}
      <section className="flex flex-wrap items-start justify-between gap-4 border-b border-border py-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium">{m.saveTitle}</h2>
          <p className="mt-1 text-sm text-text-secondary">{m.saveHint}</p>
        </div>
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="project-template-save"
          disabled={loading || !!error}
          onClick={async () => {
            setBusy(true)
            setFailure(null)
            try {
              const document = await snapshot()
              if (resource.hasSubscribers()) setSaving(document)
            } catch (error) {
              if (resource.hasSubscribers()) setFailure({ error })
            } finally {
              if (resource.hasSubscribers()) setBusy(false)
            }
          }}
        >
          {m.save}
        </button>
      </section>
      <section className="flex flex-wrap items-start justify-between gap-4 border-b border-border py-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium">{m.export}</h2>
          <p className="mt-1 text-sm text-text-secondary">{m.exportHint}</p>
        </div>
        <button
          type="button"
          className="collaboration-template-choice"
          data-testid="project-template-export"
          disabled={loading || !!error}
          onClick={async () => {
            setBusy(true)
            setFailure(null)
            try {
              const document = await snapshot()
              if (resource.hasSubscribers())
                downloadTemplate(document, 'collaboration-template.yaml')
            } catch (error) {
              if (resource.hasSubscribers()) setFailure({ error })
            } finally {
              setBusy(false)
            }
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
            embedded
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
        <ProjectTemplateApplyDialog
          api={api}
          agentConfiguration={agentConfiguration}
          projectId={project.id}
          document={selected}
          locale={locale}
          currentUserId={currentUserId}
          onClose={() => {
            setSelected(null)
            void reload()
          }}
          onApplied={latest => {
            setSelected(null)
            void reload()
            onChange?.(latest)
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
    </ProjectSettingsPage>
  )
}
