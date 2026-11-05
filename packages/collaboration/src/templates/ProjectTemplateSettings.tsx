// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import { BookmarkPlus, ChevronRight, Download, Share2, Upload } from 'lucide-react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'
import { useCollaborationTemplateStore } from './context'
import { downloadTemplate, templateFromProject } from './document'
import { templateFailureMessage, templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { TemplateBindingsDialog, type TemplateParticipant } from './TemplateBindings'
import { TemplateSaveDialog } from './TemplateSaveDialog'
import type { CollaborationTemplate } from './types'
import { applyProjectTemplate } from './projectConfiguration'
import { PartialTemplateApplyError } from './apply'
import { readTemplateAgents, templateRoutingResolver } from './agents'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'

interface ProjectTemplateSettingsProps {
  api: SharedWorkspaceApi
  agentConfiguration?: ProjectAgentConfigurationHost
  projectId: string
  locale: CollaborationLocale
  currentUserId?: number
  canManage: boolean
  onImported?(): Promise<void>
  onChange?(project: CollaborationProject): void | Promise<void>
}

export function ProjectTemplateSettings(props: ProjectTemplateSettingsProps) {
  const store = useCollaborationTemplateStore()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus()
    wasOpen.current = open
  }, [open])
  if (!store) return null
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="collaboration-secondary-button collaboration-project-sharing-trigger"
        data-testid="collaboration-project-settings-sharing"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Share2 aria-hidden="true" />
        {templateMessages[props.locale].configuration}
      </button>
      {open && <ProjectTemplateSettingsContent {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function ProjectTemplateSettingsContent({
  api,
  agentConfiguration,
  projectId,
  locale,
  currentUserId,
  canManage,
  onImported,
  onChange,
  onClose,
}: ProjectTemplateSettingsProps & { onClose(): void }) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [groups, setGroups] = useState<CollaborationGroup[]>([])
  const [configurationProject, setConfigurationProject] = useState<CollaborationProject | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<
    { type: 'actions' | 'browse' } | { type: 'bind' | 'save'; document: CollaborationTemplate }
  >({ type: 'actions' })
  const [candidates, setCandidates] = useState<TemplateParticipant[]>([])
  const scope = useRef(0)
  const reload = useCallback(async () => {
    const generation = ++scope.current
    setLoading(true)
    try {
      const [result, latest, rules] = await Promise.all([
        api.projects.listCollaborationGroups?.(projectId) ?? Promise.resolve([]),
        api.projects.get(projectId),
        api.automations?.list(projectId) ?? Promise.resolve([]),
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
  }, [api, projectId, m.failed])
  useEffect(() => {
    setGroups([])
    void reload()
    return () => {
      scope.current++
    }
  }, [reload])
  if (!store) return null
  const snapshot = async () => {
    if (!configurationProject) throw new Error('Project configuration has not loaded')
    return templateFromProject(
      configurationProject,
      groups,
      `template-${crypto.randomUUID()}`,
      locale,
      await readTemplateAgents(
        await api.agents.list(projectId, { forceRefresh: true }),
        groups,
        agentConfiguration?.readTemplateAgent
      )
    )
  }
  const withSnapshot = async (action: (document: CollaborationTemplate) => void) => {
    const generation = scope.current
    setLoading(true)
    setError(null)
    try {
      const document = await snapshot()
      if (scope.current === generation) action(document)
    } catch (error) {
      if (scope.current === generation) setError(templateFailureMessage(error, locale))
    } finally {
      if (scope.current === generation) setLoading(false)
    }
  }
  const back = { label: m.back, onClick: () => setStep({ type: 'actions' }) }
  if (step.type === 'browse') {
    return (
      <CollaborationTemplatePage
        store={store}
        locale={locale}
        dialog={{ onClose, back }}
        onUse={record => setStep({ type: 'bind', document: record.document })}
      />
    )
  }
  if (step.type === 'bind') {
    return (
      <TemplateBindingsDialog
        document={step.document}
        locale={locale}
        candidates={candidates}
        currentUserId={currentUserId}
        existingNames={groups.map(group => group.name)}
        dialogOptions={{
          size: 'standard',
          back: { label: m.back, onClick: () => setStep({ type: 'browse' }) },
        }}
        onClose={onClose}
        onApplied={() => setStep({ type: 'actions' })}
        onApply={async (drafts, document) => {
          try {
            await applyProjectTemplate(
              api,
              projectId,
              document,
              drafts,
              locale,
              m.partial,
              templateRoutingResolver(
                agentConfiguration,
                configurationProject?.project_store === 'local' ? 'local' : 'cloud',
                projectId,
                locale
              )
            )
          } catch (error) {
            // Partial imports have persisted groups even though configuration failed.
            if (error instanceof PartialTemplateApplyError) await onImported?.()
            throw error
          }
          await onImported?.()
          const latest = await reload()
          if (latest) await onChange?.(latest)
        }}
      />
    )
  }
  if (step.type === 'save') {
    return (
      <TemplateSaveDialog
        document={step.document}
        store={store}
        locale={locale}
        dialogOptions={{ size: 'standard', back }}
        onClose={onClose}
      />
    )
  }
  return (
    <TemplateDialog
      title={m.configuration}
      description={m.configurationHint}
      closeLabel={m.close}
      size="compact"
      onClose={onClose}
    >
      <div
        className="collaboration-sharing-actions"
        data-testid="project-template-settings"
        aria-busy={loading}
      >
        {error && (
          <p role="alert" className="collaboration-template-error">
            {error}{' '}
            <button
              type="button"
              data-testid="project-template-retry"
              onClick={() => void reload()}
            >
              {m.retry}
            </button>
          </p>
        )}
        {canManage && api.projects.createCollaborationGroup && (
          <button
            type="button"
            className="collaboration-sharing-action"
            data-testid="project-template-import"
            disabled={loading || !!error}
            onClick={async () => {
              const generation = scope.current
              setLoading(true)
              try {
                const [members, agents] = await Promise.all([
                  api.members.list(projectId),
                  api.agents.list(projectId),
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
                setStep({ type: 'browse' })
              } catch {
                if (scope.current === generation) setError(m.failed)
              } finally {
                if (scope.current === generation) setLoading(false)
              }
            }}
          >
            <Upload aria-hidden="true" />
            <span>
              <strong>{m.importProject}</strong>
              <small>{m.sharingImportHint}</small>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="collaboration-sharing-action"
          data-testid="project-template-save"
          disabled={loading || !!error}
          onClick={() => void withSnapshot(document => setStep({ type: 'save', document }))}
        >
          <BookmarkPlus aria-hidden="true" />
          <span>
            <strong>{m.saveTitle}</strong>
            <small>{m.saveHint}</small>
          </span>
          <ChevronRight aria-hidden="true" />
        </button>
        <button
          type="button"
          className="collaboration-sharing-action"
          data-testid="project-template-export"
          disabled={loading || !!error}
          onClick={() =>
            void withSnapshot(document => downloadTemplate(document, 'collaboration-template.yaml'))
          }
        >
          <Download aria-hidden="true" />
          <span>
            <strong>{m.export}</strong>
            <small>{m.sharingExportHint}</small>
          </span>
          <ChevronRight aria-hidden="true" />
        </button>
        {loading && (
          <p role="status" className="collaboration-template-muted">
            {m.loading}
          </p>
        )}
      </div>
    </TemplateDialog>
  )
}
