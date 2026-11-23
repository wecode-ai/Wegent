import type { useDesktopPaneWorkspaceTargets } from './useDesktopPaneWorkspaceTargets'
import type { DesktopWorkbenchMainProps } from './desktopWorkbenchMainHelpers'
import type { LocalHarnessDescriptor } from '@/lib/local-terminal'
import { useLocalHarnessResume } from './useLocalHarnessResume'
import { useCallback, useMemo } from 'react'
import { Bot } from 'lucide-react'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { type RightWorkspaceHarnessTab } from './workspace-panels/RightWorkspacePanel'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import {
  closeLocalTerminal,
  isLocalHarnessAvailable,
  resolveLocalHarnessPluginRoots,
  startLocalHarness,
  type LocalHarnessPluginLocation,
} from '@/lib/local-terminal'
import {
  buildLocalHarnessLaunchArgs,
  localHarnessLabel,
  localHarnessPluginRootFromSkillPath,
  type LocalHarnessId,
  type LocalHarnessPreference,
} from '@/lib/local-harness'
import {
  listLocalHarnessModelOptions,
  type LocalHarnessModelOption,
} from '@/features/local-harness/localHarnessModels'
import { type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import { useWorkbenchPaneSession } from './useWorkbenchPaneSession'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import type { ModelSelectionConfig, RuntimeTaskAddress } from '@/types/api'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import type { WorkspaceAddMenuItem } from './workspace-panels/WorkspaceAddMenu'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { TFunction } from 'i18next'
import type { DesktopPaneWorkspaceState } from './desktopPaneWorkspaceState'
import type { DesktopPaneWorkspaceSession } from './desktopPaneWorkspaceSession'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { Dispatch, SetStateAction } from 'react'
interface Input {
  captureScope: DesktopPaneWorkspaceSession['captureScope']
  onLocalHarnessSessionStarted: NonNullable<
    DesktopWorkbenchMainProps['onLocalHarnessSessionStarted']
  >
  activeLocalHarnessSession: LocalHarnessWorkbenchSession | null
  experimentalFeaturesEnabled: boolean
  projectChat: WorkbenchPaneContextValue['projectChat']
  services: WorkbenchServices
  t: TFunction<'common'>
  setHarnessSessionPickerTarget: Dispatch<SetStateAction<'main' | 'right' | null>>
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProject: WorkbenchPaneIdentity['currentProject']
  paneModelChat: ProjectChatControls
  paneInput: string
  setPaneInput: ReturnType<typeof useWorkbenchPaneSession>['setInput']
  newChatRuntime: 'codex' | LocalHarnessId
  localHarnessModelKeys: Partial<Record<LocalHarnessId, string | null>>
  enabledLocalHarnesses: LocalHarnessPreference[]
  localHarnesses: LocalHarnessDescriptor[]
  centralHarnessStarting: boolean
  setCentralHarnessStarting: Dispatch<SetStateAction<boolean>>
  centralHarnessError: string | null
  setCentralHarnessError: Dispatch<SetStateAction<string | null>>
  setAdditionalHarnessError: Dispatch<SetStateAction<string | null>>
  defaultEmbeddedBrowserLabel: string
  submitPaneInput: ReturnType<typeof useWorkbenchPaneSession>['send']
  paneProjectWork: ReturnType<typeof useWorkbenchPaneEnvironment>['projectWork']
  centralHarnessRequestIdRef: DesktopPaneWorkspaceSession['resources']['centralHarnessRequestIdRef']
  ownershipKey: string
  setRightPanelOpen: DesktopPaneWorkspaceState['setRightPanelOpen']
  setRightPanelView: DesktopPaneWorkspaceState['setRightPanelView']
  setRightPanelTabs: DesktopPaneWorkspaceState['setRightPanelTabs']
  composerWorkspaceTarget: WorkspaceTarget | null
  centralHarnessTargetDevice: ReturnType<
    typeof useDesktopPaneWorkspaceTargets
  >['centralHarnessTargetDevice']
  centralHarnessCwd: string
  preferLocalWorkspaceTerminal: boolean
  canPrepareHarnessWorktree: boolean
}
export function useDesktopPaneHarnessActions({
  captureScope,
  onLocalHarnessSessionStarted,
  activeLocalHarnessSession,
  experimentalFeaturesEnabled,
  projectChat,
  services,
  t,
  setHarnessSessionPickerTarget,
  currentRuntimeTask,
  currentProject,
  paneModelChat,
  paneInput,
  setPaneInput,
  newChatRuntime,
  localHarnessModelKeys,
  enabledLocalHarnesses,
  localHarnesses,
  centralHarnessStarting,
  setCentralHarnessStarting,
  centralHarnessError,
  setCentralHarnessError,
  setAdditionalHarnessError,
  defaultEmbeddedBrowserLabel,
  submitPaneInput,
  paneProjectWork,
  centralHarnessRequestIdRef,
  ownershipKey,
  setRightPanelOpen,
  setRightPanelView,
  setRightPanelTabs,
  composerWorkspaceTarget,
  centralHarnessTargetDevice,
  centralHarnessCwd,
  preferLocalWorkspaceTerminal,
  canPrepareHarnessWorktree,
}: Input) {
  const selectedHarnessPreference =
    !experimentalFeaturesEnabled || newChatRuntime === 'codex'
      ? null
      : (enabledLocalHarnesses.find(preference => preference.id === newChatRuntime) ?? null)
  const getHarnessModelOptions = useCallback(
    (harnessId: LocalHarnessId) =>
      listLocalHarnessModelOptions(
        harnessId,
        paneModelChat.models,
        paneModelChat.selectedModel,
        paneModelChat.selectedModelOptions
      ),
    [paneModelChat.models, paneModelChat.selectedModel, paneModelChat.selectedModelOptions]
  )
  const getSelectedHarnessModel = useCallback(
    (preference: LocalHarnessPreference): LocalHarnessModelOption | null => {
      const options = getHarnessModelOptions(preference.id)
      const hasPendingSelection = Object.prototype.hasOwnProperty.call(
        localHarnessModelKeys,
        preference.id
      )
      const configuredKey = hasPendingSelection
        ? localHarnessModelKeys[preference.id]
        : preference.modelKey
      if (!configuredKey) return null
      return options.find(option => option.key === configuredKey) ?? null
    },
    [getHarnessModelOptions, localHarnessModelKeys]
  )
  const getConfiguredHarnessModelKey = useCallback(
    (preference: LocalHarnessPreference): string | null => {
      const hasPendingSelection = Object.prototype.hasOwnProperty.call(
        localHarnessModelKeys,
        preference.id
      )
      return (
        (hasPendingSelection
          ? localHarnessModelKeys[preference.id]
          : preference.modelKey
        )?.trim() || null
      )
    },
    [localHarnessModelKeys]
  )
  const harnessModelOptions = selectedHarnessPreference
    ? getHarnessModelOptions(selectedHarnessPreference.id)
    : []
  const selectedHarnessModel = selectedHarnessPreference
    ? getSelectedHarnessModel(selectedHarnessPreference)
    : null
  const selectedHarnessModelKey = selectedHarnessPreference
    ? getConfiguredHarnessModelKey(selectedHarnessPreference)
    : null
  const selectedHarnessInstalled = Boolean(
    selectedHarnessPreference &&
    localHarnesses.some(harness => harness.id === selectedHarnessPreference.id && harness.installed)
  )
  const selectedHarnessExecutablePath =
    selectedHarnessPreference?.executablePath ??
    localHarnesses.find(harness => harness.id === selectedHarnessPreference?.id)?.executable_path ??
    undefined
  const selectedHarnessAvailable = Boolean(
    selectedHarnessInstalled &&
    isLocalHarnessAvailable() &&
    preferLocalWorkspaceTerminal &&
    canPrepareHarnessWorktree &&
    centralHarnessCwd &&
    (!selectedHarnessModelKey || (selectedHarnessModel && services?.localHarnessModelApi))
  )
  const activeNewChatRuntime: 'codex' | LocalHarnessId =
    experimentalFeaturesEnabled && newChatRuntime !== 'codex' && selectedHarnessInstalled
      ? newChatRuntime
      : 'codex'
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const resolveHarnessPluginRoots = useCallback(async () => {
    const [skillsResult, installedResult] = await Promise.allSettled([
      projectChat.listLocalSkills(),
      localPluginApi.listInstalledPlugins(),
    ])
    if (skillsResult.status === 'rejected') {
      console.warn('Failed to resolve local skill roots for local Harness:', skillsResult.reason)
    }
    if (installedResult.status === 'rejected') {
      console.warn(
        'Failed to resolve installed plugin roots for local Harness:',
        installedResult.reason
      )
    }
    const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : []
    const installed = installedResult.status === 'fulfilled' ? installedResult.value : { items: [] }
    const skillRoots = skills.flatMap(skill => {
      if (!skill.plugin_name) return []
      const root = localHarnessPluginRootFromSkillPath(skill.path)
      return root ? [root] : []
    })
    const pluginLocations = installed.items.flatMap<LocalHarnessPluginLocation>(plugin => {
      if (
        !plugin.spec.enabled ||
        (plugin.spec.installState !== 'installed' &&
          plugin.spec.installState !== 'update_available')
      ) {
        return []
      }
      const sourcePayload = plugin.spec.sourcePayload ?? {}
      const marketplacePath =
        typeof sourcePayload.marketplacePath === 'string'
          ? sourcePayload.marketplacePath.trim()
          : ''
      const pluginName =
        (typeof sourcePayload.pluginName === 'string' && sourcePayload.pluginName.trim()) ||
        plugin.spec.source.pluginKey?.trim() ||
        ''
      return marketplacePath && pluginName ? [{ marketplacePath, pluginName }] : []
    })
    let resolvedRoots: string[] = []
    try {
      resolvedRoots = await resolveLocalHarnessPluginRoots(pluginLocations)
    } catch (error) {
      console.warn('Failed to resolve installed Agent Plugin roots for local Harness:', error)
    }
    return Array.from(new Set([...skillRoots, ...resolvedRoots]))
  }, [localPluginApi, projectChat])
  const launchHarnessSession = useCallback(
    async ({
      preference,
      model,
      prompt,
      isPrimary,
      projectId,
      cwd,
      resumeSession,
      activate = true,
      onError = setCentralHarnessError,
    }: {
      preference: LocalHarnessPreference
      model: LocalHarnessModelOption | null
      prompt: string
      isPrimary: boolean
      projectId: number | null
      cwd: string
      resumeSession?: LocalHarnessWorkbenchSession
      activate?: boolean
      onError?: (message: string) => void
    }): Promise<LocalHarnessWorkbenchSession | null> => {
      const scope = captureScope()
      setCentralHarnessStarting(true)
      setCentralHarnessError(null)
      const requestId = centralHarnessRequestIdRef.current + 1
      centralHarnessRequestIdRef.current = requestId
      let proxyToken: string | null = null
      try {
        const pluginRoots = resumeSession?.pluginRoots ?? (await resolveHarnessPluginRoots())
        if (!scope.isCurrent() || centralHarnessRequestIdRef.current !== requestId) return null
        const modelLaunch = model
          ? await services?.localHarnessModelApi?.resolveLaunch(preference.id, model)
          : null
        if (model && !modelLaunch) {
          throw new Error(t('workbench.harness_model_required', '请选择可用的 Wework 模型'))
        }
        proxyToken = modelLaunch?.proxyToken ?? null
        if (!scope.isCurrent() || centralHarnessRequestIdRef.current !== requestId) {
          if (proxyToken) await services.localHarnessModelApi?.unregisterProxy(proxyToken)
          return null
        }
        const sessionId = await startLocalHarness({
          harnessId: preference.id,
          prompt,
          isPrimary,
          projectId,
          cwd,
          executablePath: preference.executablePath,
          args: buildLocalHarnessLaunchArgs(preference, modelLaunch?.modelId ?? null),
          pluginRoots,
          proxyToken: modelLaunch?.proxyToken,
          modelKey: model?.key ?? null,
          resumeSessionId: resumeSession?.sessionId,
          env: {
            ...preference.env,
            ...(modelLaunch?.env ?? {}),
            WEWORK_EMBEDDED_BROWSER_LABEL: defaultEmbeddedBrowserLabel,
          },
        })
        if (!scope.isCurrent() || centralHarnessRequestIdRef.current !== requestId) {
          await closeLocalTerminal(sessionId)
          if (modelLaunch) {
            await services?.localHarnessModelApi?.unregisterProxy(modelLaunch.proxyToken)
          }
          return null
        }
        if (!resumeSession) {
          setPaneInput('')
        }
        const session: LocalHarnessWorkbenchSession = {
          sessionId,
          harnessId: preference.id,
          cwd,
          title:
            resumeSession?.title ||
            prompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 80) ||
            localHarnessLabel(preference.id),
          createdAt: resumeSession?.createdAt ?? Date.now(),
          isPrimary,
          projectId,
          active: true,
          modelKey: model?.key ?? null,
          pluginRoots,
          proxyToken: modelLaunch?.proxyToken,
        }
        onLocalHarnessSessionStarted(session, { activate })
        return session
      } catch (error) {
        console.error('Failed to launch local Harness session:', {
          harnessId: preference.id,
          resumeSessionId: resumeSession?.sessionId ?? null,
          error,
        })
        if (proxyToken) {
          await services?.localHarnessModelApi?.unregisterProxy(proxyToken)
        }
        if (!scope.isCurrent() || centralHarnessRequestIdRef.current !== requestId) return null
        onError(
          error instanceof Error
            ? error.message
            : t('workbench.harness_start_failed', '启动编码工具失败')
        )
        return null
      } finally {
        if (scope.isCurrent() && centralHarnessRequestIdRef.current === requestId)
          setCentralHarnessStarting(false)
      }
    },
    [
      setCentralHarnessError,
      captureScope,
      setCentralHarnessStarting,
      centralHarnessRequestIdRef,
      resolveHarnessPluginRoots,
      services,
      defaultEmbeddedBrowserLabel,
      onLocalHarnessSessionStarted,
      t,
      setPaneInput,
    ]
  )
  const activeHarnessResumePreference =
    activeLocalHarnessSession && !activeLocalHarnessSession.active
      ? (enabledLocalHarnesses.find(
          candidate => candidate.id === activeLocalHarnessSession.harnessId
        ) ?? null)
      : null
  const activeHarnessResumeModelKey = activeLocalHarnessSession?.modelKey?.trim() || null
  const harnessModelsReady = paneModelChat.isModelSelectionReady ?? true
  const activeHarnessResumeModel =
    activeLocalHarnessSession && activeHarnessResumePreference
      ? (getHarnessModelOptions(activeHarnessResumePreference.id).find(
          option => option.key === activeHarnessResumeModelKey
        ) ?? null)
      : null
  const activeHarnessResumeError =
    activeLocalHarnessSession && !activeLocalHarnessSession.active
      ? !activeHarnessResumePreference
        ? t('workbench.harness_resume_disabled', {
            name: localHarnessLabel(activeLocalHarnessSession.harnessId),
            defaultValue: `${localHarnessLabel(activeLocalHarnessSession.harnessId)} 已禁用，无法恢复会话`,
          })
        : harnessModelsReady && activeHarnessResumeModelKey && !activeHarnessResumeModel
          ? t('workbench.harness_model_required', '请选择可用的 Wework 模型')
          : null
      : null
  const harnessResumeLaunchError = useLocalHarnessResume({
    get ownerKey() {
      return ownershipKey
    },
    session: activeLocalHarnessSession,
    preference: activeHarnessResumePreference,
    model: activeHarnessResumeModel,
    modelKey: activeHarnessResumeModelKey,
    modelsReady: harnessModelsReady,
    launch: launchHarnessSession,
    t,
  })
  const activeHarnessDisplayError =
    activeHarnessResumeError ??
    (harnessResumeLaunchError &&
    harnessResumeLaunchError.sessionId === activeLocalHarnessSession?.sessionId
      ? harnessResumeLaunchError.message
      : null) ??
    centralHarnessError
  const resolvePrimaryHarnessCwd = useCallback(async () => {
    if (!centralHarnessCwd) {
      throw new Error(
        t('workbench.harness_start_unavailable', {
          name: newChatRuntime === 'codex' ? '' : localHarnessLabel(newChatRuntime),
        })
      )
    }
    if (paneProjectWork.executionMode !== 'git_worktree') return centralHarnessCwd

    const deviceId =
      composerWorkspaceTarget?.deviceId ?? centralHarnessTargetDevice?.device_id ?? null
    const runtimeWorkApi = services?.runtimeWorkApi
    if (!deviceId || !runtimeWorkApi) {
      throw new Error(t('workbench.create_permanent_worktree_unavailable'))
    }
    const branch = paneProjectWork.worktreeBranch?.trim()
    const prepared = await runtimeWorkApi.prepareWorktree({
      deviceId,
      sourcePath: centralHarnessCwd,
      worktreeId: `harness-${crypto.randomUUID()}`,
      ...(branch ? { ref: branch } : {}),
    })
    return prepared.path ?? prepared.worktree.path
  }, [
    centralHarnessCwd,
    centralHarnessTargetDevice?.device_id,
    composerWorkspaceTarget?.deviceId,
    newChatRuntime,
    paneProjectWork.executionMode,
    paneProjectWork.worktreeBranch,
    services.runtimeWorkApi,
    t,
  ])
  const submitWorkbenchInput = async (
    value?: string,
    options?: {
      guideWhenBusy?: boolean
      interruptWhenBusy?: boolean
      runtime?: 'codex' | 'claude_code'
      runtimeExecutablePath?: string
      runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
      modelSelection?: ModelSelectionConfig | null
    }
  ) => {
    const scope = captureScope()
    if (currentRuntimeTask || activeNewChatRuntime === 'codex') {
      return submitPaneInput(value, options)
    }
    if (activeNewChatRuntime === 'claude_code') {
      return submitPaneInput(value, {
        ...options,
        runtime: 'claude_code',
        runtimeExecutablePath: selectedHarnessExecutablePath,
        runtimePermissionMode:
          selectedHarnessPreference?.permissionMode === 'bypass'
            ? 'bypassPermissions'
            : (selectedHarnessPreference?.permissionMode ?? 'default'),
        modelSelection: selectedHarnessModel
          ? {
              modelName: selectedHarnessModel.model.name,
              modelType: selectedHarnessModel.model.type,
              options: selectedHarnessModel.options,
            }
          : null,
      })
    }

    const prompt = (value ?? paneInput).trim()
    if (!prompt || centralHarnessStarting) return
    if (!selectedHarnessAvailable || !centralHarnessCwd || !selectedHarnessPreference) {
      const harnessName = newChatRuntime === 'codex' ? '' : localHarnessLabel(newChatRuntime)
      setCentralHarnessError(
        t('workbench.harness_start_unavailable', {
          name: harnessName,
          defaultValue: `当前工作区无法启动 ${harnessName}`,
        })
      )
      return
    }

    try {
      const cwd = await resolvePrimaryHarnessCwd()
      if (!scope.isCurrent()) return
      await launchHarnessSession({
        preference: selectedHarnessPreference,
        model: selectedHarnessModel,
        prompt,
        isPrimary: true,
        projectId: currentProject?.id ?? null,
        cwd,
      })
    } catch (error) {
      if (!scope.isCurrent()) return
      setCentralHarnessError(
        error instanceof Error
          ? error.message
          : t('workbench.harness_start_failed', '启动编码工具失败')
      )
    }
  }
  const startAdditionalHarnessSession = useCallback(
    async (
      harnessId: LocalHarnessId,
      target: 'main' | 'right',
      model: LocalHarnessModelOption | null
    ) => {
      const scope = captureScope()
      if (centralHarnessStarting) return

      const preference = enabledLocalHarnesses.find(candidate => candidate.id === harnessId)
      const installed = localHarnesses.some(
        harness => harness.id === harnessId && harness.installed
      )
      if (
        !preference ||
        !installed ||
        !centralHarnessCwd ||
        !preferLocalWorkspaceTerminal ||
        !canPrepareHarnessWorktree ||
        (model && !services?.localHarnessModelApi)
      ) {
        setCentralHarnessError(
          t('workbench.harness_start_unavailable', {
            name: localHarnessLabel(harnessId),
            defaultValue: `当前工作区无法启动 ${localHarnessLabel(harnessId)}`,
          })
        )
        return
      }

      try {
        setAdditionalHarnessError(null)
        const cwd = activeLocalHarnessSession?.cwd ?? (await resolvePrimaryHarnessCwd())
        if (!scope.isCurrent()) return
        const session = await launchHarnessSession({
          preference,
          model,
          prompt: '',
          isPrimary: false,
          projectId: activeLocalHarnessSession?.projectId ?? currentProject?.id ?? null,
          cwd,
          activate: target === 'main',
          onError: target === 'right' ? setAdditionalHarnessError : setCentralHarnessError,
        })
        if (!scope.isCurrent()) return
        if (session && target === 'right') {
          const tab = `harness:${session.sessionId}` as RightWorkspaceHarnessTab
          setRightPanelOpen(true)
          setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
          setRightPanelView(tab)
        }
      } catch (error) {
        if (!scope.isCurrent()) return
        const message =
          error instanceof Error
            ? error.message
            : t('workbench.harness_start_failed', '启动编码工具失败')
        if (target === 'right') {
          setAdditionalHarnessError(message)
        } else {
          setCentralHarnessError(message)
        }
      }
    },
    [
      activeLocalHarnessSession,
      canPrepareHarnessWorktree,
      captureScope,
      centralHarnessCwd,
      centralHarnessStarting,
      currentProject,
      enabledLocalHarnesses,
      launchHarnessSession,
      localHarnesses,
      preferLocalWorkspaceTerminal,
      resolvePrimaryHarnessCwd,
      services,
      setAdditionalHarnessError,
      setCentralHarnessError,
      setRightPanelOpen,
      setRightPanelTabs,
      setRightPanelView,
      t,
    ]
  )
  const harnessSessionPickerOptions = useMemo(
    () =>
      enabledLocalHarnesses.map(preference => ({
        id: preference.id,
        disabled: Boolean(
          centralHarnessStarting ||
          !localHarnesses.some(harness => harness.id === preference.id && harness.installed) ||
          !centralHarnessCwd ||
          !preferLocalWorkspaceTerminal ||
          !canPrepareHarnessWorktree
        ),
        models: services?.localHarnessModelApi ? getHarnessModelOptions(preference.id) : [],
        selectedModel: services?.localHarnessModelApi ? getSelectedHarnessModel(preference) : null,
      })),
    [
      canPrepareHarnessWorktree,
      centralHarnessCwd,
      centralHarnessStarting,
      enabledLocalHarnesses,
      getHarnessModelOptions,
      getSelectedHarnessModel,
      localHarnesses,
      preferLocalWorkspaceTerminal,
      services,
    ]
  )
  const createHarnessWorkspaceActions = useCallback(
    (target: 'main' | 'right'): WorkspaceAddMenuItem[] =>
      enabledLocalHarnesses.length > 0
        ? [
            {
              id: 'harness',
              testId: 'workspace-add-harness-option',
              icon: Bot,
              label: `${t(
                'workbench.harness_session_picker_title',
                '新建编码会话'
              )} · ${t('workbench.experimental_badge', '实验性')}`,
              disabled: harnessSessionPickerOptions.every(option => option.disabled),
              onSelect: () => setHarnessSessionPickerTarget(target),
            },
          ]
        : [],
    [enabledLocalHarnesses.length, harnessSessionPickerOptions, setHarnessSessionPickerTarget, t]
  )
  const rightHarnessWorkspaceActions = useMemo(
    () => createHarnessWorkspaceActions('right'),
    [createHarnessWorkspaceActions]
  )
  const bottomHarnessWorkspaceActions = useMemo(
    () => createHarnessWorkspaceActions('main'),
    [createHarnessWorkspaceActions]
  )
  return {
    selectedHarnessPreference,
    getHarnessModelOptions,
    harnessModelOptions,
    selectedHarnessModel,
    activeNewChatRuntime,
    activeHarnessDisplayError,
    submitWorkbenchInput,
    startAdditionalHarnessSession,
    harnessSessionPickerOptions,
    rightHarnessWorkspaceActions,
    bottomHarnessWorkspaceActions,
  }
}
