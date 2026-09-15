import {
  RuntimeConfigurationContext,
  RuntimeConfigurationRevisionContext,
  RuntimeProfilePickerContext,
  ExecutionRuntimeConfigurationContext,
  type ProfileConfigurationTarget,
  type Configured,
} from './context'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationProject,
  CollaborationIssue,
  CollaborationExecution,
} from '../types'
import { ProjectRuntimeSettings } from '../project-manage/ProjectRuntimeSettings'
import { ProjectExecutionEnvironments } from '../project-manage/ProjectExecutionEnvironments'

export function RuntimeConfigurationProvider({
  api,
  project,
  locale,
  children,
}: {
  api?: SharedWorkspaceApi | null
  project?: Pick<
    CollaborationProject,
    'id' | 'workspace_id' | 'access_role'
  > | null
  locale: string
  children: ReactNode
}) {
  const [request, setRequest] = useState<{
    projectId: string
    onConfigured?: Configured
    target?: ProfileConfigurationTarget
  } | null>(null)
  const [environments, setEnvironments] = useState(false)
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const t = useMemo(
    () => createCollaborationTranslator(locale === 'zh-CN' ? 'zh-CN' : 'en'),
    [locale],
  )
  const open =
    api?.automationExecutionCatalog && project
      ? (onConfigured?: Configured) => {
          setEnvironments(false)
          setRequest({ projectId: project.id, onConfigured })
        }
      : null
  const visible = Boolean(request && request.projectId === project?.id && api)
  const openPicker =
    api?.automationExecutionCatalog && project
      ? (target: ProfileConfigurationTarget) => {
          setEnvironments(false)
          setRequest({ projectId: project.id, target })
        }
      : null
  const configureExecution =
    openPicker && api && project
      ? async (
          issue: Pick<
            CollaborationIssue,
            'id' | 'execution_id' | 'assignee_agent_id'
          >,
          onConfigured: (execution: CollaborationExecution) => void,
        ) => {
          const rows = await api.executions.list(project.id, {
            agentId: issue.assignee_agent_id ?? undefined,
            status: 'waiting_runtime',
          })
          const execution = rows.find(
            (row) =>
              row.id === issue.execution_id && row.loop_item_id === issue.id,
          )
          if (!execution) throw new Error(t('runtimeSettings.executionChanged'))
          if (!execution.can_select_runtime)
            throw new Error(t('runtimeSettings.ownerRequired'))
          openPicker({
            title: t('runtimeSettings.executionTitle'),
            description: t('runtimeSettings.executionDescription'),
            saveLabel: t('runtimeSettings.executionSave'),
            savedLabel: t('runtimeSettings.executionSaved'),
            apply: async (profile) => {
              const updated = await api.runtimeProfiles.selectExecution(
                project.id,
                execution.id,
                profile.id,
                execution.version,
              )
              onConfigured(updated)
            },
          })
        }
      : null
  const close = () => {
    dialog.current?.close()
    setRequest(null)
  }
  useEffect(() => setRequest(null), [project?.id])
  useEffect(() => {
    if (visible) dialog.current?.showModal()
    else dialog.current?.close()
  }, [visible])

  return (
    <RuntimeConfigurationContext.Provider value={open}>
      <RuntimeProfilePickerContext.Provider value={openPicker}>
        <ExecutionRuntimeConfigurationContext.Provider
          value={configureExecution}
        >
          <RuntimeConfigurationRevisionContext.Provider value={revision}>
            {children}
            {visible && api && project ? (
              <dialog
                ref={dialog}
                className="collaboration-dialog m-auto max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-background p-6 text-text-primary backdrop:bg-black/50"
                aria-label={
                  request?.target?.title ?? t('runtimeSettings.title')
                }
                data-testid="runtime-configuration-dialog"
                onCancel={(event) => {
                  if (saving) event.preventDefault()
                  else setRequest(null)
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  {environments ? (
                    <button
                      type="button"
                      className="collaboration-secondary-button min-h-11"
                      data-testid="runtime-configuration-back"
                      disabled={saving}
                      onClick={() => setEnvironments(false)}
                    >
                      {t('runtimeSettings.back')}
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    className="collaboration-secondary-button min-h-11"
                    data-testid="runtime-configuration-close"
                    disabled={saving}
                    onClick={close}
                  >
                    {t('runtimeSettings.done')}
                  </button>
                </div>
                {environments ? (
                  <ProjectExecutionEnvironments
                    api={api}
                    project={project}
                    translate={t}
                  />
                ) : (
                  <ProjectRuntimeSettings
                    api={api}
                    projectId={project.id}
                    translate={t}
                    initialCreating
                    target={request?.target}
                    onSavingChange={setSaving}
                    onConfigured={async (profile) => {
                      await request?.onConfigured?.(profile)
                      if (!request?.target) setRevision((value) => value + 1)
                    }}
                    onConfigureEnvironments={() => setEnvironments(true)}
                  />
                )}
              </dialog>
            ) : null}
          </RuntimeConfigurationRevisionContext.Provider>
        </ExecutionRuntimeConfigurationContext.Provider>
      </RuntimeProfilePickerContext.Provider>
    </RuntimeConfigurationContext.Provider>
  )
}
