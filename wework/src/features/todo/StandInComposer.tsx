import { type ReactNode, type Dispatch, type SetStateAction } from 'react'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { useStandInComposerDraft } from './useStandInComposerDraft'
import { type WorkspaceStandInSettings } from '@wegent/collaboration'
import { useProjectWorktreeAvailabilityProbe } from '@/components/layout/useProjectWorktreeAvailabilityProbe'
import { resolveProjectWorktreeAvailability } from '@/lib/worktree-availability'
import { ProjectWorkBar, ProjectWorkSection } from '@/components/chat/composer/ProjectWorkBar'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { ComposerCatalogContext } from '@/components/chat/composer/ComposerCatalogContext'
import { useStandInComposerCatalog } from './useStandInComposerCatalog'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { listProjectBranches } from '@/api/environment'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeProjectKey, runtimeProjectToProject } from '@/lib/runtime-project'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import { StandInSettingsError } from './StandInSettingsLayout'
import { standInProjectWorkspace } from './useStandInRuntimeWork'

type StandInComposerProps = {
  draft: WorkspaceStandInSettings
  onChange: Dispatch<SetStateAction<WorkspaceStandInSettings>>
  onSave(prompt: string, draft: WorkspaceStandInSettings): Promise<void | boolean>
  disabled: boolean
  submitDisabled: boolean
  deviceControl?: ReactNode
  runtimeWork?: RuntimeWorkListResponse | null
  devices: DeviceInfo[]
  services?: WorkbenchServices
  showPrompt?: boolean
}

/** Configuration uses the ordinary composer without starting a conversation. */
export function StandInComposer(props: StandInComposerProps) {
  const configuration = useStandInComposerDraft(props.draft, props.services, props.showPrompt)
  return <StandInComposerFields {...props} {...configuration} />
}

/** Allows a draft owner to share the same resolved model with its external save action. */
export function StandInComposerFields({
  draft,
  onChange,
  onSave,
  disabled,
  submitDisabled,
  deviceControl,
  runtimeWork,
  devices,
  services,
  showPrompt = true,
  models,
}: StandInComposerProps & {
  models: ReturnType<typeof useStandInComposerDraft>['models']
}) {
  const { t } = useTranslation('common')
  const rows = (runtimeWork?.projects ?? []).flatMap(row => {
    const workspace = standInProjectWorkspace(row, draft.executionDeviceId)
    return workspace ? [{ ...row, deviceWorkspaces: [workspace] }] : []
  })
  const projects = rows.map(runtimeProjectToProject)
  const selected = rows.find(row => runtimeProjectKey(row.project) === draft.workspace?.projectKey)
  const project = selected ? runtimeProjectToProject(selected) : null
  const workspace = selected?.deviceWorkspaces[0] ?? null
  const composerCatalog = useStandInComposerCatalog(
    draft.executionDeviceId
      ? {
          deviceId: draft.executionDeviceId,
          scope: 'workspace',
          workspacePath: workspace?.workspacePath ?? null,
        }
      : null,
    services,
    t
  )
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
      services?.deviceApi && services.runtimeWorkApi && project
        ? () =>
            listProjectBranches(
              {
                executeCommand: (deviceId, data) =>
                  services.deviceApi!.executeCommand(deviceId, data),
                preflightWorktree: data => services.runtimeWorkApi!.preflightWorktree(data),
              },
              project
            )
        : undefined,
  }
  const environment = draft.workspace
    ? `${project?.name ?? draft.workspace.projectKey} · ${t(draft.workspace.executionMode === 'git_worktree' ? 'standIn.new_worktree' : 'standIn.current_workspace')}`
    : t('standIn.inherit_environment')
  return (
    <div className="space-y-3">
      <div
        className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11"
        data-testid="stand-in-workspace-bar"
      >
        {deviceControl && (
          <>
            <span className="text-text-secondary">{t('standIn.device_label')}</span>
            <div className="min-w-0">{deviceControl}</div>
          </>
        )}
        <span className="text-text-secondary">{t('standIn.local_project')}</span>
        <div className="min-w-0" inert={disabled || !draft.executionDeviceId}>
          <ProjectWorkBar
            {...projectWork}
            className="min-h-11 px-0 md:min-h-8"
            menuClassName="z-critical"
            showWorkSection={false}
          />
        </div>
        <span className="text-text-secondary">{t('standIn.workspace_label')}</span>
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1" inert={disabled}>
          {project ? (
            <ProjectWorkSection context={{ ...projectWork, project }} />
          ) : (
            <span className="px-1.5 text-text-secondary">{t('standIn.inherit_environment')}</span>
          )}
        </div>
        <span className="self-start pt-3 text-text-secondary md:pt-1.5">
          {t('standIn.model_label')}
        </span>
        <div className="min-w-0">
          <ModelSelector
            models={models.models}
            getModelOptionId={models.getModelOptionId}
            selectedModel={models.selectedModel}
            selectedModelOptions={draft.modelOptions ?? {}}
            disabled={disabled}
            onOpenChange={open => {
              if (open) models.refresh()
            }}
            onSelectModel={model =>
              onChange(current => ({ ...current, model: models.resolve(model) }))
            }
            onSelectModelAndOptions={(model, options) =>
              onChange(current => {
                const modelOptions = { ...current.modelOptions }
                delete modelOptions.reasoning
                delete modelOptions.reasoningEffort
                return {
                  ...current,
                  model: models.resolve(model),
                  modelOptions: { ...modelOptions, ...options },
                }
              })
            }
            onSelectModelOption={(key, value) =>
              onChange(current => ({
                ...current,
                modelOptions: { ...current.modelOptions, [key]: value },
              }))
            }
          />
          {models.loading && (
            <p
              role="status"
              data-testid="stand-in-models-loading"
              className="text-xs text-text-secondary"
            >
              {t('workbench.local_model_loading_models_action')}
            </p>
          )}
          <StandInSettingsError
            error={models.error}
            retry={{ testId: 'stand-in-models-retry', disabled, onClick: models.refresh }}
          />
        </div>
      </div>
      {showPrompt && (
        <ComposerCatalogContext.Provider value={composerCatalog}>
          <BufferedChatInput
            value={draft.prompt}
            onChange={prompt => onChange(current => ({ ...current, prompt }))}
            onDraftEdit={prompt => onChange(current => ({ ...current, prompt }))}
            onSubmit={prompt => onSave(prompt ?? draft.prompt, draft)}
            disabled={disabled}
            submitDisabled={submitDisabled}
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
          />
        </ComposerCatalogContext.Provider>
      )}
    </div>
  )
}
