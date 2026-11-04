// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject } from '../types'
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
  const [groups, setGroups] = useState<CollaborationGroup[]>([])
  const [configurationProject, setConfigurationProject] = useState(project)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [selected, setSelected] = useState<CollaborationTemplate | null>(null)
  const [saving, setSaving] = useState<CollaborationTemplate | null>(null)
  const scope = useRef(0)
  const reload = useCallback(async () => {
    const generation = ++scope.current
    setLoading(true)
    try {
      const [result, latest, rules] = await Promise.all([
        api.projects.listCollaborationGroups?.(project.id) ?? Promise.resolve([]),
        api.projects.get(project.id),
        api.automations?.list(project.id) ?? Promise.resolve([]),
      ])
      if (scope.current === generation) {
        setGroups(result)
        setConfigurationProject({
          ...latest,
          automatic_processing_rules: rules,
        })
        setError(null)
        return latest
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
            onClick={() => setChoosing(true)}
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
          onClick={async () => {
            setLoading(true)
            setError(null)
            try {
              setSaving(await snapshot())
            } catch (error) {
              setError(templateFailureMessage(error, locale))
            } finally {
              setLoading(false)
            }
          }}
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
          onClick={async () => {
            setLoading(true)
            setError(null)
            try {
              downloadTemplate(await snapshot(), 'collaboration-template.yaml')
            } catch (error) {
              setError(templateFailureMessage(error, locale))
            } finally {
              setLoading(false)
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
    </section>
  )
}
