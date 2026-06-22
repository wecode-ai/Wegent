import { Folder, FolderPlus, Loader2, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canUseForProjectCreation,
  isCloudDevice,
  isClaudeCodeDevice,
} from '@/lib/device-capabilities'
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeleteDeviceWorkspaceRequest,
  DeviceInfo,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  DeviceWorkspaceResponse,
  GitBranch,
  GitRepoInfo,
  ProjectWithTasks,
} from '@/types/api'
import type { DeviceUpgradeState } from '@/types/device-events'
import {
  DeviceFolderPicker,
  type DeviceFolderPickerMode,
  type DeviceFolderPickerResult,
} from './DeviceFolderPicker'
import { basename } from './device-folder-path'

type ProjectCreateMode = 'scratch' | 'existing' | 'git'
type ProjectWorkspaceKind = 'worktree' | 'workspace'

interface ProjectCreateDialogProps {
  open: boolean
  mode: ProjectCreateMode
  presentation?: 'dialog' | 'mobileSheet'
  project?: ProjectWithTasks | null
  deviceWorkspaces?: DeviceWorkspaceResponse[]
  devices: DeviceInfo[]
  onClose: () => void
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject?: (
    data: CreateGitWorkspaceProjectRequest
  ) => Promise<ProjectWithTasks>
  onPrepareDeviceWorkspace?: (
    data: DeviceWorkspacePrepareRequest
  ) => Promise<DeviceWorkspacePrepareResponse>
  onDeleteDeviceWorkspace?: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  onDeviceWorkspacePrepared?: (response: DeviceWorkspacePrepareResponse) => Promise<void> | void
  onUpdateProjectName?: (projectId: number, name: string) => Promise<void>
  showWorkspaceKindSelect?: boolean
  preferredDeviceId?: string | null
  onSelectDevicePreference?: (deviceId: string) => void
  onOpenCloudDeviceSettings?: () => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  upgradingDevices?: Record<string, DeviceUpgradeState>
  onUpgradeDevice?: (deviceId: string) => Promise<void>
  onListGitRepositories?: () => Promise<GitRepoInfo[]>
  onListGitBranches?: (repo: GitRepoInfo) => Promise<GitBranch[]>
}

interface DeviceFolderPickerState {
  deviceId: string
  mode: DeviceFolderPickerMode
}

function sortDevicesForProjectCreation(devices: DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((left, right) => {
    const leftUsable = canUseForProjectCreation(left) ? 0 : 1
    const rightUsable = canUseForProjectCreation(right) ? 0 : 1
    if (leftUsable !== rightUsable) return leftUsable - rightUsable

    const leftCloud = isCloudDevice(left) ? 0 : 1
    const rightCloud = isCloudDevice(right) ? 0 : 1
    if (leftCloud !== rightCloud) return leftCloud - rightCloud

    return (left.name || left.device_id).localeCompare(right.name || right.device_id)
  })
}

function getProjectDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return sortDevicesForProjectCreation(devices.filter(isClaudeCodeDevice))
}

function getDefaultDeviceId(devices: DeviceInfo[], preferredDeviceId?: string | null): string {
  const preferredDevice = preferredDeviceId
    ? devices.find(device => device.device_id === preferredDeviceId)
    : undefined
  return preferredDevice?.device_id ?? devices[0]?.device_id ?? ''
}

function getFolderProjectName(path: string): string {
  return basename(path)
}

function getDeviceLabel(device: DeviceInfo): string {
  return device.name || device.device_id
}

function getInitialVisibleDeviceIds(
  devices: DeviceInfo[],
  preferredDeviceId?: string | null
): string[] {
  const defaultDeviceId = getDefaultDeviceId(devices, preferredDeviceId)
  return defaultDeviceId ? [defaultDeviceId] : []
}

function getInitialActiveDeviceId(
  devices: DeviceInfo[],
  deviceWorkspaces: DeviceWorkspaceResponse[],
  preferredDeviceId: string | null | undefined,
  editing: boolean
): string {
  if (editing) {
    const mappedDevice = deviceWorkspaces.find(workspace =>
      devices.some(device => device.device_id === workspace.deviceId)
    )
    if (mappedDevice) return mappedDevice.deviceId
  }
  return getDefaultDeviceId(devices, preferredDeviceId)
}

function mappingsByDeviceId(
  deviceWorkspaces: DeviceWorkspaceResponse[]
): Map<string, DeviceWorkspaceResponse> {
  const byDeviceId = new Map<string, DeviceWorkspaceResponse>()
  for (const workspace of deviceWorkspaces) {
    if (!byDeviceId.has(workspace.deviceId)) {
      byDeviceId.set(workspace.deviceId, workspace)
    }
  }
  return byDeviceId
}

export function ProjectCreateDialog(props: ProjectCreateDialogProps) {
  if (!props.open) return null

  return (
    <ProjectCreateDialogContent
      key={`${props.project?.id ?? 'new'}:${props.mode}:${getDefaultDeviceId(
        getProjectDevices(props.devices),
        props.preferredDeviceId
      )}`}
      {...props}
    />
  )
}

function ProjectCreateDialogContent({
  mode,
  presentation = 'dialog',
  project,
  deviceWorkspaces = [],
  devices = [],
  onClose,
  onCreateProject,
  onPrepareDeviceWorkspace,
  onDeleteDeviceWorkspace,
  onDeviceWorkspacePrepared,
  onUpdateProjectName,
  showWorkspaceKindSelect = false,
  preferredDeviceId,
  onSelectDevicePreference,
  onOpenCloudDeviceSettings,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
}: ProjectCreateDialogProps) {
  const { t } = useTranslation('common')
  const isEditing = Boolean(project)
  const allProjectDevices = useMemo(() => getProjectDevices(devices), [devices])
  const existingMappings = useMemo(() => mappingsByDeviceId(deviceWorkspaces), [deviceWorkspaces])
  const [visibleDeviceIds, setVisibleDeviceIds] = useState<string[]>(() =>
    isEditing
      ? allProjectDevices.map(device => device.device_id)
      : getInitialVisibleDeviceIds(allProjectDevices, preferredDeviceId)
  )
  const [activeDeviceId, setActiveDeviceId] = useState(() =>
    getInitialActiveDeviceId(allProjectDevices, deviceWorkspaces, preferredDeviceId, isEditing)
  )
  const [folderDrafts, setFolderDrafts] = useState<Record<string, DeviceFolderPickerResult>>({})
  const [removedDeviceIds, setRemovedDeviceIds] = useState<Set<string>>(() => new Set())
  const [folderPickerState, setFolderPickerState] = useState<DeviceFolderPickerState | null>(null)
  const [projectName, setProjectName] = useState(project?.name ?? '')
  const [renamingInline, setRenamingInline] = useState(Boolean(project))
  const [workspaceKind, setWorkspaceKind] = useState<ProjectWorkspaceKind>('worktree')
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const visibleDevices = allProjectDevices.filter(device =>
    visibleDeviceIds.includes(device.device_id)
  )
  const activeDevice =
    visibleDevices.find(device => device.device_id === activeDeviceId) ?? visibleDevices[0] ?? null
  const pickerDevice = folderPickerState
    ? allProjectDevices.find(device => device.device_id === folderPickerState.deviceId)
    : null
  const selectedDrafts = Object.values(folderDrafts)
  const primaryDraft = selectedDrafts[0]
  const derivedProjectName = primaryDraft ? getFolderProjectName(primaryDraft.path) : ''
  const finalProjectName = projectName.trim() || derivedProjectName
  const hasHiddenDevices = !isEditing && visibleDeviceIds.length < allProjectDevices.length
  const canSubmit = isEditing ? true : Boolean(selectedDrafts.length && finalProjectName)
  const title = isEditing
    ? t('workbench.project_edit_title', '编辑项目')
    : t('workbench.project_choose_folder_title', '选择项目文件夹')
  const description = isEditing
    ? t('workbench.project_edit_folder_desc', '为每台设备选择或调整这个项目关联的文件夹。')
    : t(
        'workbench.project_choose_folder_desc',
        '为这台设备选择或新建一个文件夹。项目名默认使用文件夹名称。'
      )
  const isMobileSheet = presentation === 'mobileSheet'

  useEscapeKey(onClose, !submitting)

  const revealOtherDevices = () => {
    setVisibleDeviceIds(allProjectDevices.map(device => device.device_id))
  }

  const selectDevice = (deviceId: string) => {
    setActiveDeviceId(deviceId)
    onSelectDevicePreference?.(deviceId)
  }

  const setFolderDraft = (result: DeviceFolderPickerResult) => {
    setFolderDrafts(drafts => ({ ...drafts, [result.deviceId]: result }))
    setRemovedDeviceIds(deviceIds => {
      const next = new Set(deviceIds)
      next.delete(result.deviceId)
      return next
    })
    setProjectName(name => name || getFolderProjectName(result.path))
    setProjectCreateError(null)
    setFolderPickerState(null)
  }

  const unlinkActiveDevice = () => {
    if (!activeDevice) return
    setFolderDrafts(drafts => {
      const next = { ...drafts }
      delete next[activeDevice.device_id]
      return next
    })
    setRemovedDeviceIds(deviceIds => new Set(deviceIds).add(activeDevice.device_id))
    setProjectCreateError(null)
  }

  const getDeviceFolder = (deviceId: string) => {
    const draft = folderDrafts[deviceId]
    if (draft) return draft.path
    if (removedDeviceIds.has(deviceId)) return ''
    return existingMappings.get(deviceId)?.workspacePath ?? ''
  }

  const isDeviceLinked = (deviceId: string) => Boolean(getDeviceFolder(deviceId))

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setProjectCreateError(null)
    try {
      if (isEditing && project) {
        const nextName = projectName.trim()
        if (nextName && nextName !== project.name && onUpdateProjectName) {
          await onUpdateProjectName(project.id, nextName)
        }
        if (onDeleteDeviceWorkspace) {
          for (const deviceId of removedDeviceIds) {
            const mapping = existingMappings.get(deviceId)
            if (mapping) {
              await onDeleteDeviceWorkspace({
                projectId: project.id,
                deviceId,
                workspacePath: mapping.workspacePath,
              })
            }
          }
        }
        if (onPrepareDeviceWorkspace) {
          for (const draft of selectedDrafts) {
            const preparedWorkspace = await onPrepareDeviceWorkspace({
              projectId: project.id,
              deviceId: draft.deviceId,
              workspacePath: draft.path,
              action: draft.action,
              ...(showWorkspaceKindSelect ? { label: workspaceKind } : {}),
            })
            await onDeviceWorkspacePrepared?.(preparedWorkspace)
          }
        }
      } else {
        if (!selectedDrafts.length || !finalProjectName || !onPrepareDeviceWorkspace) return
        const createdProject = await onCreateProject({
          name: finalProjectName,
          description: '',
          config: { mode: mode === 'git' ? 'workspace' : 'workspace' },
        })
        for (const draft of selectedDrafts) {
          const preparedWorkspace = await onPrepareDeviceWorkspace({
            projectId: createdProject.id,
            deviceId: draft.deviceId,
            workspacePath: draft.path,
            action: draft.action,
            ...(showWorkspaceKindSelect ? { label: workspaceKind } : {}),
          })
          await onDeviceWorkspacePrepared?.(preparedWorkspace)
        }
      }
      onClose()
    } catch (error) {
      setProjectCreateError(
        error instanceof Error
          ? error.message
          : t('workbench.project_create_failed', '项目创建失败')
      )
    } finally {
      setSubmitting(false)
    }
  }

  const renderActiveDevicePanel = () => {
    if (!activeDevice) return null

    const folderPath = getDeviceFolder(activeDevice.device_id)
    const canUseDevice = canUseForProjectCreation(activeDevice)

    return (
      <section className="mt-4 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[#202124]">{getDeviceLabel(activeDevice)}</p>
            <p className="mt-1 truncate font-mono text-xs text-[#6b6f76]">
              {folderPath || t('workbench.project_device_folder_empty', '尚未关联文件夹')}
            </p>
          </div>
          {isEditing && folderPath && (
            <button
              type="button"
              data-testid="project-device-unlink-button"
              disabled={submitting}
              onClick={unlinkActiveDevice}
              className="h-8 shrink-0 rounded-md border border-[#d8d8d8] px-2 text-xs font-medium text-[#8a3b3b] hover:bg-[#fff1f1] disabled:opacity-50"
            >
              {t('workbench.project_unlink_device_folder', '解除关联')}
            </button>
          )}
        </div>

        {showWorkspaceKindSelect && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(
              [
                ['worktree', t('workbench.project_workspace_kind_worktree', 'Worktree')],
                ['workspace', t('workbench.project_workspace_kind_workspace', '普通地址')],
              ] as [ProjectWorkspaceKind, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-testid={`project-workspace-kind-${value}`}
                disabled={submitting}
                onClick={() => setWorkspaceKind(value)}
                className={[
                  'min-h-10 rounded-lg border px-2 text-[12px] font-medium',
                  workspaceKind === value
                    ? 'border-text-primary bg-text-primary text-background'
                    : 'border-[#d8d8d8] text-[#3c4043] hover:bg-[#f7f7f8]',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="project-folder-select-button"
            disabled={submitting || !canUseDevice}
            onClick={() =>
              setFolderPickerState({ deviceId: activeDevice.device_id, mode: 'select' })
            }
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#d8d8d8] bg-white px-3 text-sm font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:opacity-50"
          >
            <Folder className="h-4 w-4" />
            {t('workbench.project_folder_select_existing', '选择已有')}
          </button>
          <button
            type="button"
            data-testid="project-folder-create-button"
            disabled={submitting || !canUseDevice}
            onClick={() =>
              setFolderPickerState({ deviceId: activeDevice.device_id, mode: 'create' })
            }
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#d8d8d8] bg-white px-3 text-sm font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" />
            {t('workbench.project_folder_create_new', '新建')}
          </button>
        </div>

        {folderPickerState?.deviceId === activeDevice.device_id && pickerDevice && (
          <div className="mt-3">
            <DeviceFolderPicker
              device={pickerDevice}
              mode={folderPickerState.mode}
              onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
              onListDeviceDirectories={onListDeviceDirectories}
              onCreateDeviceDirectory={onCreateDeviceDirectory}
              onCancel={() => setFolderPickerState(null)}
              onConfirm={setFolderDraft}
            />
          </div>
        )}
      </section>
    )
  }

  return createPortal(
    <div
      className={
        isMobileSheet
          ? 'fixed inset-0 z-[10000] flex items-end justify-center bg-black/30 px-0'
          : 'fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4'
      }
    >
      <div
        data-testid="project-create-dialog"
        className={
          isMobileSheet
            ? 'max-h-[88dvh] w-full overflow-y-auto rounded-t-[28px] border border-[#EDEDED] border-b-0 bg-white p-5 pb-[max(24px,env(safe-area-inset-bottom))] shadow-[0_-18px_48px_rgba(0,0,0,0.18)]'
            : 'max-h-[88vh] w-full max-w-[680px] overflow-y-auto rounded-lg border border-[#d8d8d8] bg-white p-6 shadow-2xl'
        }
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#202124]">{title}</h2>
            <p className="mt-2 text-[13px] leading-[18px] text-[#6b6f76]">{description}</p>
          </div>
          <button
            type="button"
            data-testid="close-project-create-dialog-button"
            onClick={() => {
              if (!submitting) onClose()
            }}
            disabled={submitting}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#606368] hover:bg-[#f1f3f4] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {allProjectDevices.length === 0 && onOpenCloudDeviceSettings && (
          <p className="mt-5 text-sm leading-5 text-[#606368]">
            {t('workbench.project_no_available_devices_hint', '创建项目需要一台可用设备。')}
            <a
              href="/settings"
              data-testid="open-cloud-device-settings-link"
              onClick={event => {
                event.preventDefault()
                onOpenCloudDeviceSettings()
              }}
              className="ml-1 font-medium text-[#14b8a6] underline underline-offset-2 hover:text-[#0f9f93]"
            >
              {t('workbench.project_create_cloud_device_connection', '创建云设备连接')}
            </a>
          </p>
        )}

        {isEditing ? (
          <label className="mt-5 block">
            <span className="text-[13px] font-semibold text-[#202124]">
              {t('workbench.project_name', '项目名称')}
            </span>
            <input
              data-testid="project-name-input"
              value={projectName}
              disabled={submitting}
              onChange={event => {
                setProjectName(event.target.value)
                setProjectCreateError(null)
              }}
              className="mt-2 h-10 w-full rounded-lg border border-[#d8d8d8] px-3 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
            />
          </label>
        ) : primaryDraft ? (
          <div className="mt-5 rounded-lg border border-[#e5e5e5] bg-[#f7f7f8] px-3 py-2">
            {renamingInline ? (
              <input
                data-testid="project-name-input"
                value={projectName}
                disabled={submitting}
                onChange={event => setProjectName(event.target.value)}
                className="h-9 w-full rounded-md border border-[#d8d8d8] bg-white px-2 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
              />
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p data-testid="project-name-preview" className="truncate text-sm text-[#3c4043]">
                  {t('workbench.project_name_preview', {
                    defaultValue: '项目名：{{name}}',
                    name: finalProjectName,
                  })}
                </p>
                <button
                  type="button"
                  data-testid="project-rename-inline-button"
                  onClick={() => setRenamingInline(true)}
                  className="h-8 shrink-0 rounded-md px-2 text-xs font-medium text-[#0f766e] hover:bg-[#e5f6f4]"
                >
                  {t('workbench.rename_project', '重命名项目')}
                </button>
              </div>
            )}
          </div>
        ) : null}

        {allProjectDevices.length > 0 && (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {visibleDevices.map(device => {
                const active = activeDevice?.device_id === device.device_id
                const linked = isDeviceLinked(device.device_id)
                return (
                  <button
                    key={device.device_id}
                    type="button"
                    data-testid={`project-device-tab-${device.device_id}`}
                    onClick={() => selectDevice(device.device_id)}
                    className={[
                      'min-h-10 rounded-md border px-3 text-left text-sm',
                      active
                        ? 'border-text-primary bg-text-primary text-background'
                        : 'border-[#d8d8d8] text-[#3c4043] hover:bg-[#f7f7f8]',
                    ].join(' ')}
                  >
                    <span className="font-medium">{getDeviceLabel(device)}</span>
                    <span className="ml-2 text-xs opacity-75">
                      {linked
                        ? t('workbench.project_device_linked', '已关联')
                        : t('workbench.project_device_unlinked', '未关联')}
                    </span>
                  </button>
                )
              })}
              {hasHiddenDevices && (
                <button
                  type="button"
                  data-testid="project-add-other-device-button"
                  onClick={revealOtherDevices}
                  className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[#d8d8d8] px-3 text-sm font-medium text-[#3c4043] hover:bg-[#f7f7f8]"
                >
                  <Plus className="h-4 w-4" />
                  {t('workbench.project_add_other_device', '添加其他设备')}
                </button>
              )}
            </div>
            {renderActiveDevicePanel()}
          </>
        )}

        {projectCreateError && (
          <p className="mt-4 rounded-md bg-[#fff1f1] px-3 py-2 text-sm text-[#8a3b3b]">
            {projectCreateError}
          </p>
        )}

        <div className="mt-7 flex justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-project-create-button"
            disabled={submitting}
            onClick={onClose}
            className="h-10 rounded-md border border-[#d8d8d8] px-4 text-[13px] font-medium text-[#3c4043] hover:bg-[#f7f7f8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="create-project-button"
            disabled={!canSubmit || submitting}
            onClick={() => void handleSubmit()}
            aria-busy={submitting}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-text-primary px-4 text-[13px] font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting && (
              <Loader2 data-testid="project-submit-spinner" className="h-4 w-4 animate-spin" />
            )}
            {isEditing ? t('workbench.save', '保存') : t('workbench.create_project', '创建项目')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
