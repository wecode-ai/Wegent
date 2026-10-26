// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CollaborationTranslate } from '../i18n'
import type {
  SharedWorkspaceApi,
  WorkspaceGitBranch,
  WorkspaceGitRepository,
} from '../ports/SharedWorkspaceApi'
import type {
  CollaborationExecutionEnvironment,
  CollaborationExecutionEnvironmentDeviceState,
  CollaborationExecutionEnvironmentRepository,
  CollaborationExecutionEnvironmentSetupStep,
  CollaborationProject,
  CollaborationWorkspace,
} from '../types'
import { ProjectEnvironmentConfiguration } from './ProjectEnvironmentConfiguration'
import { ProjectEnvironmentDevices } from './ProjectEnvironmentDevices'
import { ProjectDeviceAccessSettings } from './ProjectDeviceAccessSettings'
import { repositoryKey } from './environmentConfiguration'
import { environmentAuthorizationError } from './environmentAuthorization'
import { useExecutionEnvironmentList } from '../execution-environment/useExecutionEnvironmentList'
import { compareExecutionEnvironments } from '../execution-environment/compareExecutionEnvironments'
import { ensureWorkspaceEnvironmentSharing } from '../execution-environment/ensureWorkspaceEnvironmentSharing'

type RepositoryDraft = CollaborationExecutionEnvironmentRepository & {
  id: string
}
type SetupStepDraft = CollaborationExecutionEnvironmentSetupStep & {
  id: string
}

let nextDraftId = 0

function draftId(prefix: string) {
  nextDraftId += 1
  return `${prefix}-${nextDraftId}`
}

// Device errors embed the executor's absolute paths and the whole git stderr;
// keep the stage prefix and git's decisive line, the full text stays in title.
const LEGACY_REPOSITORY_FREE_ERROR =
  'Execution environment must have exactly one primary repository'

function executionEnvironmentErrorSummary(
  message: string,
  repositoryFree: boolean,
  translate: CollaborationTranslate
): string {
  if (repositoryFree && message.includes(LEGACY_REPOSITORY_FREE_ERROR)) {
    return translate(
      'todo.execution_environment_blank_workspace_upgrade_required',
      '当前设备的 Executor 不支持空白执行环境，请升级或重启 Executor 后重试；也可以先添加一个主代码仓库。'
    )
  }
  const fatalLines = message.match(/fatal: [^\n]+/g)
  if (!fatalLines?.length) {
    return message
  }
  const detail = fatalLines[fatalLines.length - 1]
  const stage = message.match(/^(Failed to [^:\n]+):/)
  return stage ? `${stage[1]}: ${detail}` : detail
}

// Short name used for both the display name and the clone directory, for
// example "wegent" for "wecode-ai/Wegent".
function repositoryShortName(repository: WorkspaceGitRepository) {
  const segment = repository.fullName.split('/').filter(Boolean).pop() ?? repository.name
  return segment.replace(/\.git$/, '') || repository.name
}

function repositoryShortNameFromUrl(url: string) {
  return (
    url
      .split(/[/:]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/, '') ?? ''
  )
}

type BranchState = {
  status: 'loading' | 'ready' | 'error'
  branches: WorkspaceGitBranch[]
}

// Stable empty map so the prop-sync effect does not re-run on every render
// when the environment has never been prepared on any device.
type DeviceStateMap = Record<string, CollaborationExecutionEnvironmentDeviceState>
const NO_DEVICE_STATES: DeviceStateMap = {}

type ExecutionEnvironmentScope =
  | {
      project: Pick<
        CollaborationProject,
        | 'id'
        | 'workspace_id'
        | 'project_store'
        | 'access_role'
        | 'version'
        | 'execution_environment'
      >
      workspace?: never
    }
  | {
      project?: never
      workspace: Pick<
        CollaborationWorkspace,
        'id' | 'access_role' | 'version' | 'execution_environment' | 'location'
      >
    }

function canManageEnvironment(role: string | undefined, workspaceScope: boolean) {
  return role === 'Owner' || role === 'Maintainer' || (workspaceScope && role === 'Developer')
}

export function ProjectExecutionEnvironments({
  api,
  onManageDevices,
  onProjectChange,
  project,
  translate,
  workspace,
}: {
  api: SharedWorkspaceApi
  onManageDevices?(): void
  onProjectChange?(project: CollaborationProject): void
  translate: CollaborationTranslate
} & ExecutionEnvironmentScope) {
  const isWorkspaceScope = workspace != null
  const scopeId = workspace?.id ?? project!.id
  const testIdPrefix = isWorkspaceScope
    ? 'collaboration-workspace-execution-environment'
    : 'collaboration-project-execution-environment'
  const accessRole = workspace?.access_role ?? project?.access_role
  const canManage = canManageEnvironment(accessRole, isWorkspaceScope)
  const [pickerOpen, setPickerOpen] = useState(false)
  const assigned = useExecutionEnvironmentList(
    api,
    isWorkspaceScope ? 'workspace' : 'project',
    scopeId
  )
  const shared = useExecutionEnvironmentList(
    api,
    'workspace',
    project?.workspace_id ?? '',
    !isWorkspaceScope && Boolean(project?.workspace_id)
  )
  // Cloud grants require registered cloud IDs; local placeholder IDs are only valid locally.
  const localScope = workspace?.location === 'local' || project?.project_store === 'local'
  const requireWorkspaceSharing = !isWorkspaceScope && !localScope && Boolean(project?.workspace_id)
  const environmentAddInFlight = useRef(false)
  const personal = useExecutionEnvironmentList(
    api,
    localScope ? 'device-local' : 'device-cloud',
    '',
    pickerOpen && canManage
  )
  const assignedItems = assigned.items ?? []
  const workspaceItems = shared.items ?? []
  const personalItems = personal.items ?? []
  const loading = assigned.loading
  const pickerLoading = personal.loading || shared.loading
  const pickerError = personal.error || shared.error
  const initialConfig = workspace?.execution_environment ?? project?.execution_environment
  const [workspacePolicy, setWorkspacePolicy] = useState<'git_worktree' | 'project'>(
    initialConfig?.workspace_policy ?? 'git_worktree'
  )
  const [repositories, setRepositories] = useState<RepositoryDraft[]>(() => {
    const configured = initialConfig?.repositories ?? []
    return configured.map(repository => ({
      ...repository,
      id: draftId('repository'),
    }))
  })
  const [setupSteps, setSetupSteps] = useState<SetupStepDraft[]>(() =>
    (initialConfig?.setup_steps ?? []).map(step => ({
      ...step,
      id: draftId('setup'),
    }))
  )
  const [configVersion, setConfigVersion] = useState(workspace?.version ?? project!.version)
  const [configurationDirty, setConfigurationDirty] = useState(false)
  const [configurationSaved, setConfigurationSaved] = useState(false)
  const [configurationError, setConfigurationError] = useState('')
  const [deviceStates, setDeviceStates] = useState<DeviceStateMap>(
    initialConfig?.devices ?? NO_DEVICE_STATES
  )
  // The bottom error line follows the device the user last tried to create
  // on. A ref, so tracking it never re-triggers the prop-sync effect below.
  const environmentErrorDeviceKey = useRef('')
  const [environmentError, setEnvironmentError] = useState('')
  const [statusFilter, setStatusFilter] = useState<
    'all' | CollaborationExecutionEnvironment['status']
  >('all')
  const [saving, setSaving] = useState(false)
  const [initializingDeviceId, setInitializingDeviceId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const configuredRepositories = useMemo(
    () =>
      repositories.map(({ id: _id, ...repository }) => ({
        ...repository,
        name: repository.name.trim(),
        url: repository.url.trim(),
        ref: repository.ref.trim(),
        path: repository.path.trim(),
      })),
    [repositories]
  )
  const configuredSetupSteps = useMemo(
    () =>
      setupSteps
        .map(({ id: _id, ...step }) => ({
          command: step.command.trim(),
          workingDirectory: step.working_directory.trim(),
        }))
        .filter(step => step.command),
    [setupSteps]
  )

  // The repository catalog is cloud-only; local workspaces keep the free-text
  // inputs even when the shared api object carries the cloud capability.
  const gitRepositoriesApi = workspace?.location === 'local' ? undefined : api.gitRepositories
  const [repositoryOptions, setRepositoryOptions] = useState<WorkspaceGitRepository[] | null>(null)
  const [repositoriesLoadFailed, setRepositoriesLoadFailed] = useState(false)
  const [branchesByRepository, setBranchesByRepository] = useState<Record<string, BranchState>>({})
  // Last auto-derived values per draft, so a repository switch only replaces
  // fields the user has not customized.
  const derivedDefaults = useRef(new Map<string, { name: string; path: string; ref: string }>())
  const branchesInFlight = useRef(new Set<string>())
  const repositoriesInFlight = useRef(false)
  // `saving` is async React state, so two initialize clicks in the same tick
  // would both pass a state-based guard; the ref flips synchronously and also
  // blocks a second device's button while one initialization is in flight.
  const initializationInFlight = useRef(false)
  const configurationSaveInFlight = useRef(false)

  const incomingVersion = workspace?.version ?? project!.version
  const incomingDevices = initialConfig?.devices ?? NO_DEVICE_STATES

  // The parent re-fetches the project on a poll, so the server-owned per-device
  // states must follow the prop instead of staying stuck at the mount-time
  // values. While a create is in flight the flow writes these itself from the
  // device response, and the form drafts are user input and never re-seeded
  // here.
  useEffect(() => {
    if (initializationInFlight.current || saving) return
    if (!configurationDirty) {
      setWorkspacePolicy(initialConfig?.workspace_policy ?? 'git_worktree')
    }
    setConfigVersion(incomingVersion)
    setDeviceStates(incomingDevices)
    const errorKey = environmentErrorDeviceKey.current
    setEnvironmentError(errorKey ? (incomingDevices[errorKey]?.error ?? '') : '')
  }, [incomingVersion, incomingDevices, initialConfig?.workspace_policy])

  const loadRepositoryOptions = useCallback(async () => {
    if (!gitRepositoriesApi || repositoriesInFlight.current) return
    repositoriesInFlight.current = true
    setRepositoriesLoadFailed(false)
    try {
      setRepositoryOptions(await gitRepositoriesApi.list())
    } catch {
      setRepositoriesLoadFailed(true)
    } finally {
      repositoriesInFlight.current = false
    }
  }, [gitRepositoriesApi])

  const repositoriesByUrl = useMemo(() => {
    const byUrl = new Map<string, WorkspaceGitRepository>()
    for (const option of repositoryOptions ?? []) {
      byUrl.set(option.cloneUrl, option)
    }
    return byUrl
  }, [repositoryOptions])

  const loadBranches = useCallback(
    async (option: WorkspaceGitRepository) => {
      const key = repositoryKey(option)
      if (!gitRepositoriesApi || branchesInFlight.current.has(key)) return
      branchesInFlight.current.add(key)
      setBranchesByRepository(current => ({
        ...current,
        [key]: { status: 'loading', branches: current[key]?.branches ?? [] },
      }))
      try {
        const branches = await gitRepositoriesApi.listBranches(option)
        setBranchesByRepository(current => ({
          ...current,
          [key]: { status: 'ready', branches },
        }))
        const defaultBranch = branches.find(branch => branch.default) ?? branches[0]
        if (defaultBranch) {
          setRepositories(current =>
            current.map(draft => {
              if (draft.url !== option.cloneUrl) return draft
              const derived = derivedDefaults.current.get(draft.id)
              if (draft.ref && draft.ref !== derived?.ref) return draft
              derivedDefaults.current.set(draft.id, {
                name: derived?.name ?? '',
                path: derived?.path ?? '',
                ref: defaultBranch.name,
              })
              return { ...draft, ref: defaultBranch.name }
            })
          )
        }
      } catch {
        setBranchesByRepository(current => ({
          ...current,
          [key]: { status: 'error', branches: [] },
        }))
      } finally {
        branchesInFlight.current.delete(key)
      }
    },
    [gitRepositoriesApi]
  )

  // Resolve branches for drafts that already point at a known repository,
  // including drafts restored from a saved configuration.
  useEffect(() => {
    if (!repositoryOptions) return
    for (const draft of repositories) {
      const match = repositoriesByUrl.get(draft.url)
      if (match && !branchesByRepository[repositoryKey(match)]) {
        void loadBranches(match)
      }
    }
  }, [repositoryOptions, repositories, repositoriesByUrl, branchesByRepository, loadBranches])

  function selectRepository(id: string, key: string) {
    const option = (repositoryOptions ?? []).find(candidate => repositoryKey(candidate) === key)
    if (!option) return
    const shortName = repositoryShortName(option)
    const derivedName = option.name || shortName
    setRepositories(current =>
      current.map(draft => {
        if (draft.id !== id) return draft
        const derived = derivedDefaults.current.get(id)
        const name = !draft.name || draft.name === derived?.name ? derivedName : draft.name
        const path = !draft.path || draft.path === derived?.path ? shortName : draft.path
        // A previously auto-filled branch is unlikely to exist on the new
        // repository; the fetched default branch replaces it.
        const ref = !draft.ref || draft.ref === derived?.ref ? '' : draft.ref
        derivedDefaults.current.set(id, { name, path, ref })
        return { ...draft, url: option.cloneUrl, name, path, ref }
      })
    )
    setConfigurationDirty(true)
    setConfigurationSaved(false)
    setConfigurationError('')
    void loadBranches(option)
  }

  const selectedDeviceIds = useMemo(
    () =>
      new Set(
        assignedItems
          .map(environment => environment.device_id)
          .filter((deviceId): deviceId is number => deviceId != null)
      ),
    [assignedItems]
  )
  const workspaceDeviceIds = useMemo(
    () =>
      new Set(
        workspaceItems
          .map(environment => environment.device_id)
          .filter((deviceId): deviceId is number => deviceId != null)
      ),
    [workspaceItems]
  )
  const availableItems = useMemo(() => {
    const environments = new Map<number, CollaborationExecutionEnvironment>()
    for (const environment of [...personalItems, ...workspaceItems]) {
      if (environment.device_id != null) {
        environments.set(environment.device_id, environment)
      }
    }
    return [...environments.values()].sort(compareExecutionEnvironments)
  }, [personalItems, workspaceItems])
  const candidates = availableItems.filter(
    environment =>
      environment.device_id != null &&
      environment.status === 'online' &&
      !selectedDeviceIds.has(environment.device_id)
  )
  const matchesStatus = (environment: CollaborationExecutionEnvironment) =>
    statusFilter === 'all' || environment.status === statusFilter
  const visibleAssignedItems = assignedItems
    .filter(matchesStatus)
    .sort(compareExecutionEnvironments)
  function updateRepository(
    id: string,
    patch: Partial<CollaborationExecutionEnvironmentRepository>
  ) {
    setRepositories(current =>
      current.map(repository => {
        if (patch.primary === true) {
          return {
            ...repository,
            primary: repository.id === id,
            ...(repository.id === id ? patch : {}),
          }
        }
        return repository.id === id ? { ...repository, ...patch } : repository
      })
    )
    setConfigurationDirty(true)
    setConfigurationSaved(false)
    setConfigurationError('')
  }

  function updateRepositoryUrl(id: string, url: string) {
    const shortName = repositoryShortNameFromUrl(url)
    setRepositories(current =>
      current.map(repository => {
        if (repository.id !== id) return repository
        const derived = derivedDefaults.current.get(id)
        const name =
          !repository.name || repository.name === derived?.name ? shortName : repository.name
        const path =
          !repository.path || repository.path === derived?.path ? shortName : repository.path
        derivedDefaults.current.set(id, {
          name,
          path,
          ref: derived?.ref ?? '',
        })
        return { ...repository, url, name, path }
      })
    )
    setConfigurationDirty(true)
    setConfigurationSaved(false)
    setConfigurationError('')
  }

  function addRepository() {
    setRepositories(current => [
      ...current,
      {
        id: draftId('repository'),
        name: '',
        url: '',
        ref: '',
        path: '',
        primary: current.length === 0,
      },
    ])
    setConfigurationDirty(true)
    setConfigurationSaved(false)
    setConfigurationError('')
  }

  function removeRepository(id: string) {
    setRepositories(current => {
      const remaining = current.filter(repository => repository.id !== id)
      if (remaining.length > 0 && !remaining.some(repository => repository.primary)) {
        remaining[0] = { ...remaining[0], primary: true }
      }
      return remaining
    })
    setConfigurationDirty(true)
    setConfigurationSaved(false)
    setConfigurationError('')
  }

  function updateSetupStep(id: string, patch: Partial<CollaborationExecutionEnvironmentSetupStep>) {
    setSetupSteps(current => current.map(step => (step.id === id ? { ...step, ...patch } : step)))
    setConfigurationDirty(true)
    setConfigurationSaved(false)
    setConfigurationError('')
  }

  function markConfigurationDirty() {
    setConfigurationDirty(true)
    setConfigurationSaved(false)
    setConfigurationError('')
  }

  async function saveConfiguration() {
    if (!canManage || !configurationDirty || saving || configurationSaveInFlight.current) return
    if (
      configuredRepositories.some(
        repository => !repository.name || !repository.url || !repository.path
      )
    ) {
      setConfigurationError(
        translate(
          'todo.execution_environment_repository_incomplete',
          '请补全仓库的名称、Git 仓库和目录，或移除该仓库。'
        )
      )
      return
    }
    if (
      configuredRepositories.length > 0 &&
      configuredRepositories.filter(repository => repository.primary).length !== 1
    ) {
      setConfigurationError(
        translate(
          'todo.execution_environment_primary_repository_required',
          '请为已添加的代码仓库设置一个主仓库。'
        )
      )
      return
    }

    configurationSaveInFlight.current = true
    setSaving(true)
    setError('')
    setConfigurationError('')
    setConfigurationSaved(false)
    try {
      const executionEnvironment = {
        workspacePolicy,
        repositories: configuredRepositories,
        setupSteps: configuredSetupSteps,
      }
      const updated = isWorkspaceScope
        ? await api.workspaces!.update(scopeId, {
            version: configVersion,
            executionEnvironment,
          })
        : await api.projects
            .update(scopeId, {
              version: configVersion,
              executionEnvironment,
            })
            .then(updatedProject => {
              onProjectChange?.(updatedProject)
              return updatedProject
            })
      setConfigVersion(updated.version)
      setDeviceStates(updated.execution_environment?.devices ?? NO_DEVICE_STATES)
      setConfigurationDirty(false)
      setConfigurationSaved(true)
      setEnvironmentError('')
      environmentErrorDeviceKey.current = ''
    } catch (saveError) {
      setConfigurationError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      configurationSaveInFlight.current = false
      setSaving(false)
    }
  }

  async function addEnvironment(environment: CollaborationExecutionEnvironment) {
    const deviceId = environment.device_id
    if (
      deviceId == null ||
      !canManage ||
      saving ||
      environmentAddInFlight.current ||
      (requireWorkspaceSharing && shared.items === undefined)
    )
      return
    environmentAddInFlight.current = true
    setSaving(true)
    setError('')
    let sharing = isWorkspaceScope
    let sharedDuringAdd = false
    try {
      if (requireWorkspaceSharing && !workspaceDeviceIds.has(deviceId)) {
        sharing = true
        const sharedEnvironment = await ensureWorkspaceEnvironmentSharing(
          api,
          project!.workspace_id!,
          deviceId,
          workspaceDeviceIds
        )
        if (sharedEnvironment) {
          shared.update(current => [
            ...current.filter(item => item.device_id !== deviceId),
            sharedEnvironment,
          ])
          sharedDuringAdd = true
        }
      }
      sharing = isWorkspaceScope
      const created = isWorkspaceScope
        ? await api.workspaces!.addExecutionEnvironment(scopeId, { deviceId })
        : await api.projects.addExecutionEnvironment(scopeId, deviceId)
      assigned.update(current => [...current.filter(item => item.device_id !== deviceId), created])
      if (created.project_version != null) setConfigVersion(created.project_version)
      setPickerOpen(false)
    } catch (saveError) {
      const reason = environmentAuthorizationError(saveError, translate)
      setError(
        sharedDuringAdd
          ? translate(
              'todo.execution_environment_shared_add_failed',
              '环境已共享到空间，但添加到项目失败：{{reason}}。请重试添加。',
              { reason }
            )
          : sharing
            ? translate('todo.execution_environment_share_failed', '共享环境失败：{{reason}}', {
                reason,
              })
            : reason
      )
    } finally {
      environmentAddInFlight.current = false
      setSaving(false)
    }
  }

  async function removeEnvironment(environment: CollaborationExecutionEnvironment) {
    if (environment.device_id == null) return
    setSaving(true)
    setError('')
    try {
      if (isWorkspaceScope) {
        await api.workspaces!.removeExecutionEnvironment(scopeId, environment.device_id)
      } else {
        await api.projects.removeExecutionEnvironment(scopeId, environment.device_id)
      }
      assigned.update(current => current.filter(item => item.id !== environment.id))
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate('todo.execution_environment_remove_failed', '移除执行环境失败')
      )
    } finally {
      setSaving(false)
    }
  }

  async function createEnvironmentOnDevice(device: CollaborationExecutionEnvironment) {
    if (
      initializationInFlight.current ||
      saving ||
      device.device_id == null ||
      device.status !== 'online'
    )
      return
    if (configurationDirty) {
      setEnvironmentError(
        translate(
          'todo.execution_environment_save_before_initialization',
          '配置有未保存的修改，请先保存配置再准备项目目录。'
        )
      )
      return
    }
    initializationInFlight.current = true
    setSaving(true)
    setInitializingDeviceId(device.device_id)
    setError('')
    const deviceKey = device.device_key ?? String(device.device_id)
    try {
      // The in-flight state belongs to the clicked device (initializingDeviceId);
      // other devices keep showing their own persisted per-device state.
      setEnvironmentError('')
      const initialized = isWorkspaceScope
        ? await api.workspaces!.initializeExecutionEnvironment(scopeId, {
            deviceId: device.device_id,
            version: configVersion,
          })
        : await api.projects
            .initializeExecutionEnvironment(scopeId, {
              deviceId: device.device_id,
              version: configVersion,
            })
            .then(initializedProject => {
              onProjectChange?.(initializedProject)
              return initializedProject
            })
      const initializedConfig = initialized.execution_environment
      const nextDeviceStates = initializedConfig?.devices ?? NO_DEVICE_STATES
      const deviceState = nextDeviceStates[deviceKey]
      setConfigVersion(initialized.version)
      setDeviceStates(nextDeviceStates)
      environmentErrorDeviceKey.current = deviceKey
      setEnvironmentError(deviceState?.error ?? '')
      if (deviceState?.status !== 'ready') {
        throw new Error(
          deviceState?.error ||
            translate('todo.execution_environment_initialization_failed', '项目目录准备失败')
        )
      }
    } catch (saveError) {
      environmentErrorDeviceKey.current = deviceKey
      setEnvironmentError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      initializationInFlight.current = false
      setSaving(false)
      setInitializingDeviceId(null)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[840px]">
        <h1 className="text-heading-lg font-semibold">
          {translate(
            isWorkspaceScope
              ? 'todo.workspace_execution_environments'
              : 'todo.project_execution_environments',
            '执行环境'
          )}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {translate(
            isWorkspaceScope
              ? 'todo.workspace_execution_environments_intro'
              : 'todo.project_execution_environments_intro',
            isWorkspaceScope
              ? '管理共享给空间内项目的执行环境。'
              : '选择此项目可以使用的执行环境，项目目录会在首次运行时自动准备。'
          )}
        </p>

        <section className="mt-6">
          <ProjectEnvironmentDevices
            renderDeviceAccess={
              !isWorkspaceScope && !localScope
                ? environment =>
                    environment.use_access ? (
                      <ProjectDeviceAccessSettings
                        api={api}
                        projectId={scopeId}
                        environment={environment}
                        translate={translate}
                        onReload={assigned.refresh}
                        onChanged={async updated => {
                          setConfigVersion(updated.version)
                          onProjectChange?.(updated)
                          await assigned.refresh()
                        }}
                      />
                    ) : null
                : undefined
            }
            {...{
              testIdPrefix,
              translate,
              isWorkspaceScope,
              requireWorkspaceSharing,
              canManage,
              saving,
              loading,
              error:
                error ||
                (assigned.error instanceof Error
                  ? environmentAuthorizationError(assigned.error, translate)
                  : assigned.error
                    ? translate('todo.execution_environments_load_failed', '加载执行环境失败')
                    : ''),
              pickerLoading,
              pickerError:
                pickerError instanceof Error
                  ? environmentAuthorizationError(pickerError, translate)
                  : pickerError
                    ? translate('todo.execution_environments_load_failed', '加载执行环境失败')
                    : '',
              assignedItems,
              visibleAssignedItems,
              candidates,
              workspaceDeviceIds: shared.items ? workspaceDeviceIds : undefined,
              deviceStates,
              initializingDeviceId,
              configurationDirty,
              statusFilter,
              pickerOpen,
              onManageDevices,
              addEnvironment,
              removeEnvironment,
              createEnvironmentOnDevice,
            }}
            onRetry={() => {
              setError('')
              void assigned.refresh()
              if (requireWorkspaceSharing) void shared.refresh()
            }}
            onRetryPicker={() => {
              void personal.refresh()
              if (!isWorkspaceScope && project?.workspace_id) void shared.refresh()
            }}
            onStatusFilterChange={setStatusFilter}
            onTogglePicker={() => setPickerOpen(current => !current)}
          />
          {environmentError ? (
            <p
              className="mt-3 text-sm text-destructive"
              data-testid={`${testIdPrefix}-environment-error`}
              role="alert"
              title={environmentError}
            >
              {executionEnvironmentErrorSummary(
                environmentError,
                configuredRepositories.length === 0,
                translate
              )}
            </p>
          ) : null}
          <details
            className="group mt-6 border-t border-border"
            data-testid={`${testIdPrefix}-preparation`}
            onToggle={event => {
              if (
                event.currentTarget.open &&
                repositoryOptions === null &&
                !repositoriesLoadFailed
              ) {
                void loadRepositoryOptions()
              }
            }}
          >
            <summary
              className="flex min-h-11 cursor-pointer list-none items-center gap-3 py-4 [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-testid={`${testIdPrefix}-preparation-toggle`}
            >
              <ChevronRight
                className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {translate('todo.execution_environment_preparation', '项目准备')}
                </span>
                <span className="mt-1 block truncate text-xs text-text-muted">
                  {repositories.length || setupSteps.length
                    ? translate(
                        'todo.execution_environment_preparation_summary',
                        '{{repositories}} 个仓库 · {{steps}} 个初始化步骤',
                        {
                          repositories: repositories.length,
                          steps: setupSteps.length,
                        }
                      )
                    : translate(
                        'todo.execution_environment_preparation_default',
                        '默认使用空白工作目录，可按需添加仓库和初始化命令。'
                      )}
                </span>
              </span>
              {configurationDirty ? (
                <span className="text-xs text-text-secondary">
                  {translate('todo.execution_environment_configuration_unsaved', '有未保存的修改')}
                </span>
              ) : null}
            </summary>
            <ProjectEnvironmentConfiguration
              {...{
                testIdPrefix,
                translate,
                canManage,
                saving,
                workspacePolicy,
                repositories,
                setupSteps,
                repositoryOptions,
                repositoriesByUrl,
                repositoriesLoadFailed,
                branchesByRepository,
                loadRepositoryOptions,
                loadBranches,
                selectRepository,
                updateRepository,
                updateRepositoryUrl,
                removeRepository,
                addRepository,
                updateSetupStep,
                configurationError,
                configurationSaved,
                configurationDirty,
                saveConfiguration,
              }}
              onWorkspacePolicyChange={value => {
                setWorkspacePolicy(value)
                markConfigurationDirty()
              }}
              addSetupStep={() => {
                setSetupSteps(current => [
                  ...current,
                  { id: draftId('setup'), command: '', working_directory: '' },
                ])
                markConfigurationDirty()
              }}
              removeSetupStep={id => {
                setSetupSteps(current => current.filter(step => step.id !== id))
                markConfigurationDirty()
              }}
            />
          </details>
        </section>
      </div>
    </div>
  )
}
