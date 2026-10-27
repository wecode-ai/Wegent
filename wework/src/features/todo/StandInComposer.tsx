import { useEffect, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { useStandInModels } from './useStandInModels'
import {
  runnerModelKey,
  type WorkspaceStandInSettings,
  type WorkspaceProjectAgent,
} from '@wegent/collaboration'
import { useProjectWorktreeAvailabilityProbe } from '@/components/layout/useProjectWorktreeAvailabilityProbe'
import { resolveProjectWorktreeAvailability } from '@/lib/worktree-availability'
import { ProjectWorkBar, ProjectWorkSection } from '@/components/chat/composer/ProjectWorkBar'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { ComposerCatalogContext } from '@/components/chat/composer/ComposerCatalogContext'
import { useRuntimeComposerCatalog } from '@/components/chat/composer/useRuntimeComposerCatalog'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { listProjectBranches } from '@/api/environment'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeProjectKey, runtimeProjectToProject } from '@/lib/runtime-project'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'

/** Configuration uses the ordinary composer without starting a conversation. */
export function StandInComposer({
  draft,
  onChange,
  onSave,
  disabled,
  submitDisabled,
  controls,
  deviceControl,
  selectedAgent,
  onValidityChange,
  runtimeWork,
  devices,
  services,
  showPrompt = true,
}: {
  draft: WorkspaceStandInSettings
  onChange: Dispatch<SetStateAction<WorkspaceStandInSettings>>
  onSave(prompt: string): Promise<void | boolean>
  disabled: boolean
  submitDisabled: boolean
  onValidityChange?(valid: boolean): void
  selectedAgent?: WorkspaceProjectAgent
  deviceControl?: ReactNode
  controls: ReactNode
  runtimeWork?: RuntimeWorkListResponse | null
  devices: DeviceInfo[]
  services?: WorkbenchServices
  showPrompt?: boolean
}) {
  const { t } = useTranslation('common')
  const composerCatalog = useRuntimeComposerCatalog(
    draft.executionDeviceId
      ? {
          deviceId: draft.executionDeviceId,
          scope: 'workspace',
          workspacePath: draft.workspace?.workspacePath ?? null,
        }
      : null,
    services,
    t
  )
  const models = useStandInModels(services, draft, selectedAgent)
  useEffect(() => {
    if (!showPrompt && !draft.model) return
    const model = models.fixedIdentity ?? (showPrompt ? models.defaultIdentity : null)
    if (
      model &&
      (!draft.model ||
        (models.fixedIdentity && runnerModelKey(draft.model) !== runnerModelKey(model)))
    )
      onChange(current =>
        current.model &&
        (!models.fixedIdentity || runnerModelKey(current.model) === runnerModelKey(model))
          ? current
          : { ...current, model }
      )
  }, [draft.model, models.defaultIdentity, models.fixedIdentity, onChange, showPrompt])
  const rows = (runtimeWork?.projects ?? []).flatMap(row => {
    const workspace = row.deviceWorkspaces.find(
      workspace =>
        workspace.deviceId === draft.executionDeviceId &&
        workspace.available &&
        workspace.workspaceKind !== 'chat' &&
        workspace.workspaceSource !== 'remote'
    )
    return workspace ? [{ ...row, deviceWorkspaces: [workspace] }] : []
  })
  const projects = rows.map(runtimeProjectToProject)
  const selected = rows.find(row => runtimeProjectKey(row.project) === draft.workspace?.projectKey)
  const project = selected ? runtimeProjectToProject(selected) : null
  const workspace = selected?.deviceWorkspaces[0] ?? null
  const device =
    devices.find(device =>
      [device.device_id, device.app_device_id].includes(draft.executionDeviceId)
    ) ?? null
  const probeKey = `${draft.executionDeviceId}:${workspace?.workspacePath ?? ''}:${draft.workspace?.branch ?? ''}`
  const probe = useProjectWorktreeAvailabilityProbe({
    api: services?.runtimeWorkApi,
    device,
    enabled: Boolean(workspace),
    key: probeKey,
    project,
    workspace,
    ref: draft.workspace?.branch,
  })
  const availability =
    probe?.key === probeKey
      ? probe.availability
      : resolveProjectWorktreeAvailability({ project, workspace, device })
  const selectProject = (id: number | null) => {
    const row = rows.find(row => runtimeProjectToProject(row).id === id)
    onChange(current => ({
      ...current,
      workspace: row
        ? {
            projectKey: runtimeProjectKey(row.project),
            workspacePath: row.deviceWorkspaces[0].workspacePath,
            executionMode: 'current_workspace',
          }
        : null,
    }))
  }
  const projectWork: ProjectWorkControls = {
    projects,
    devices: devices.filter(device =>
      [device.device_id, device.app_device_id].includes(draft.executionDeviceId)
    ),
    runtimeWork: runtimeWork ? { ...runtimeWork, projects: rows, chats: [] } : undefined,
    currentProject: project,
    currentProjectId: project?.id,
    selectedDeviceWorkspaceId: workspace?.id ?? null,
    currentStandaloneDeviceId: draft.executionDeviceId,
    currentRuntimeDeviceId: draft.executionDeviceId,
    executionMode: draft.workspace?.executionMode ?? 'current_workspace',
    executionModeLocked: !draft.workspace,
    worktreeAvailability: availability,
    onSelectProject: selectProject,
    onSelectProjectWorkspace: projectId => selectProject(projectId),
    onSelectStandaloneDevice: () => {},
    onExecutionModeChange: executionMode =>
      onChange(current =>
        current.workspace
          ? {
              ...current,
              workspace: {
                ...current.workspace,
                executionMode:
                  executionMode === 'git_worktree' ? 'git_worktree' : 'current_workspace',
              },
            }
          : current
      ),
    worktreeBranch: draft.workspace?.branch,
    onWorktreeBranchChange: branch =>
      onChange(current =>
        current.workspace ? { ...current, workspace: { ...current.workspace, branch } } : current
      ),
    onListBranches:
      services?.deviceApi && project
        ? () => listProjectBranches(services.deviceApi!, project)
        : undefined,
  }
  const environment = draft.workspace
    ? `${project?.name ?? draft.workspace.projectKey} · ${t(draft.workspace.executionMode === 'git_worktree' ? 'standIn.new_worktree' : 'standIn.current_workspace')}`
    : t('standIn.inherit_environment')
  const valid = !submitDisabled
  useEffect(() => {
    onValidityChange?.(valid)
  }, [valid, onValidityChange])
  return (
    <div className="space-y-3">
      <div
        className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm"
        data-testid="stand-in-workspace-bar"
      >
        {controls && (
          <>
            <span className="text-text-muted">{t('standIn.agent_label')}</span>
            <div className="min-w-0">{controls}</div>
          </>
        )}
        <span className="text-text-muted">{t('standIn.device_label')}</span>
        <div className="min-w-0">{deviceControl}</div>
        <span className="text-text-muted">{t('standIn.local_project')}</span>
        <div className="min-w-0" inert={disabled || !draft.executionDeviceId}>
          <ProjectWorkBar
            {...projectWork}
            className="min-h-8 px-0"
            menuClassName="z-critical"
            showWorkSection={false}
          />
        </div>
        <span className="text-text-muted">{t('standIn.workspace_label')}</span>
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1" inert={disabled}>
          {project ? (
            <ProjectWorkSection context={{ ...projectWork, project }} />
          ) : (
            <span className="px-1.5 text-text-muted">{t('standIn.inherit_environment')}</span>
          )}
        </div>
        <span className="text-text-muted">{t('standIn.model_label')}</span>
        <div className="min-w-0">
          <ModelSelector
            models={models.models}
            getModelOptionId={models.getModelOptionId}
            selectedModel={models.selectedModel}
            selectedModelOptions={draft.modelOptions ?? {}}
            disabled={disabled || models.fixed}
            onSelectModel={model =>
              onChange(current => ({ ...current, model: models.resolve(model) }))
            }
            onSelectModelOption={(key, value) =>
              onChange(current => ({
                ...current,
                modelOptions: { ...current.modelOptions, [key]: value },
              }))
            }
          />
        </div>
      </div>
      {showPrompt && (
        <ComposerCatalogContext.Provider value={composerCatalog}>
          <BufferedChatInput
            value={draft.prompt}
            onChange={prompt => onChange(current => ({ ...current, prompt }))}
            onDraftEdit={prompt => onChange(current => ({ ...current, prompt }))}
            onSubmit={prompt => onSave(prompt ?? draft.prompt)}
            disabled={disabled}
            submitDisabled={!valid}
            clearOnSubmit={false}
            allowEmptySubmit
            placeholder={t(
              draft.goalMode ? 'standIn.goal_placeholder' : 'standIn.dynamic_placeholder',
              {
                environment: draft.workspace ? environment : t('standIn.default_workspace'),
              }
            )}
            variant="desktop"
            presentation="configuration"
            inputTestId="stand-in-prompt"
            submitButtonTestId="stand-in-save"
            submitLabel={t('standIn.save')}
            showProjectWorkBar={false}
            showWorkspaceMenu={false}
            showExecutionTools={false}
            onSetGoal={() => onChange(current => ({ ...current, goalMode: true }))}
            goalDraftActive={Boolean(draft.goalMode)}
            onCancelGoalDraft={() => onChange(current => ({ ...current, goalMode: false }))}
            toolbarLeadingContext={
              <>
                {models.error && (
                  <span role="status" className="text-xs text-error">
                    {models.error}
                  </span>
                )}
              </>
            }
          />
        </ComposerCatalogContext.Provider>
      )}
    </div>
  )
}
