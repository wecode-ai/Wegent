import { useProjectActions } from './useProjectActions'
import { worktreeWorkspaceDeviceId } from '../../../packages/chat-core/src/worktree-availability'
import { recordMobileDiagnostic, recordMobileDiagnosticFailure } from '@/services/mobileDiagnostics'
import * as Crypto from 'expo-crypto'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { composerApps } from '@/domain/composerApps'
import { withPhoneLocalDevice } from '@/domain/withPhoneLocalDevice'
import {
  mobileCreatableDevices,
  mobileOperableDevices,
  selectedOnlineDeviceId,
} from '@/domain/deviceOrdering'
import { resolveMobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import {
  RuntimeTaskLifecycleProjection,
  runtimeTaskKey,
  type RuntimeSendTransition,
} from '@/domain/runtimeTaskLifecycle'
import { createConversationWorkspace } from '@/domain/runtimeConversationWorkspace'
import {
  allWorkspaces,
  flattenConversations,
  mergeRuntimeWorkForDevices,
  runtimeWorkForDevices,
} from '@/domain/work'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import type { RuntimeCacheSnapshot } from '@/services/runtimeCache'
import { useMobileRuntimeSession, type MobileLocalRuntimeOptions } from './useMobileRuntimeSession'
import { useMobileProjectCreation } from './useMobileProjectCreation'
import { useRuntimePermissionPreference } from './useRuntimePermissionPreference'
import { useMobileTranscript } from './useMobileTranscript'
import { useMobileModels } from './useMobileModels'
import { useRuntimeLifecycleEvents } from './useRuntimeLifecycleEvents'
import { useRuntimeDeviceRefresh } from './useRuntimeDeviceRefresh'
import { useRuntimeWorkLists } from './useRuntimeWorkLists'
import { useRuntimeCloudConnection } from './useRuntimeCloudConnection'
import { useRuntimeCacheHydration } from './useRuntimeCacheHydration'
import { useRuntimeFailures } from './useRuntimeFailures'
import { useMobileUserInput } from './useMobileUserInput'
import { recordMobileTaskAddressRename } from '@/telemetry/taskIdentity'
import { recordMobileTaskOutcome } from '@/telemetry/taskOutcome'
import { useConversationActions } from './useConversationActions'
import {
  runtimeTaskRunning,
  sameRuntimeAddress,
  createRuntimeTaskId,
  titleFrom,
  messageFrom,
} from './mobileRuntimeHelpers'
import type { MobileRuntimeState, NewConversationOptions } from './mobileRuntimeTypes'
export type { MobileRuntimeState, NewConversationOptions } from './mobileRuntimeTypes'
import type {
  ConversationItem,
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
  RuntimeUploadAsset,
  RuntimeTranscriptResponse,
} from '@/types/runtime'

const EMPTY_WORK: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
// Read owners retain failures and expose their own retry through the avatar.
const readFailureRecorded = () => {}
export function useMobileRuntime(
  config: RuntimeSessionConfig | null,
  userId: number,
  localOptions?: MobileLocalRuntimeOptions
): MobileRuntimeState {
  const deviceInventoryRef = useRef<DeviceInfo[]>([])
  const { api, stream, cache, local, cloudConnection } = useMobileRuntimeSession(
    config,
    userId,
    localOptions,
    deviceInventoryRef
  )
  const { failures, reportFailure, clearFailure, clearRemoteFailures, retryFailure } =
    useRuntimeFailures()
  const cloudConnectedRef = useRef(cloudConnection.connected)
  cloudConnectedRef.current = cloudConnection.connected
  const [hydratedCache, setHydratedCache] = useState<typeof cache | null>(null)
  const backendIdentity = config ? `${config.apiBaseUrl}\0${userId}` : null
  const cacheHydration = useMemo(() => ({ cache, ready: false }), [cache])
  const activeCache = useRef(cacheHydration)
  activeCache.current = cacheHydration
  const lifecycle = useMemo(() => new RuntimeTaskLifecycleProjection(), [api])
  const [work, setWork] = useState(EMPTY_WORK)
  const workRef = useRef<RuntimeWorkListResponse>(EMPTY_WORK)
  const [taskRunningByKey, setTaskRunningByKey] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  )
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [currentAddress, setCurrentAddress] = useState<RuntimeTaskAddress | null>(null)
  const [currentTitle, setCurrentTitle] = useState('新会话')
  const [selectedWorkspace, setSelectedWorkspace] = useState<RuntimeDeviceWorkspace | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [allDevicesSelected, setAllDevicesSelected] = useState(false)
  const [cloudModels, setCloudModels] = useState<UnifiedModel[]>([])
  const { permissionMode, selectPermissionMode } = useRuntimePermissionPreference()
  const deviceModels = useMobileModels({
    api,
    devices,
    address: currentAddress,
    task: currentAddress
      ? allWorkspaces(work)
          .filter(workspace => workspace.deviceId === currentAddress.deviceId)
          .flatMap(workspace => workspace.tasks)
          .find(task => task.taskId === currentAddress.taskId)
      : null,
    selectedDeviceId,
    cloudModels: cloudConnection.connected ? cloudModels : [],
    backendIdentity,
    local,
    permissionMode,
  })
  const { models, selectedModel, selectedModelOptions, loadLocalModels, modelSelection } =
    deviceModels
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [stoppingTaskKey, setStoppingTaskKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connectionError = failures[0]?.error ?? null
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const currentAddressRef = useRef<RuntimeTaskAddress | null>(null)
  const workRequestRevisionRef = useRef(new Map<string, number>())
  const devicesRef = useRef<DeviceInfo[]>([])
  const modelsRef = useRef<UnifiedModel[]>([])
  const selectedDeviceIdRef = useRef<string | null>(null)
  const selectionRevisionRef = useRef(0)
  const allDevicesSelectedRef = useRef(false)
  const workByDeviceRef = useRef<Record<string, RuntimeWorkListResponse>>({})
  const stopRequestsRef = useRef(new Set<string>())

  const transcriptRetry = useRef<(address: RuntimeTaskAddress) => Promise<unknown>>(async () => {})
  const reportTranscriptFailure = useCallback(
    (
      error: string,
      address: RuntimeTaskAddress,
      page?: 'older',
      retry?: () => Promise<unknown>
    ) => {
      const phoneOwned = local?.ownsDevice(address.deviceId) ?? false
      const title =
        flattenConversations(workRef.current).find(
          item => runtimeTaskKey(item.address) === runtimeTaskKey(address)
        )?.title ?? '历史消息'
      reportFailure({
        id: `transcript${page ? '-older' : ''}:${runtimeTaskKey(address)}`,
        label: `${phoneOwned ? '本机' : '云设备'}会话 · ${title}${page ? ' · 更早消息' : ''}`,
        error,
        phoneOwned,
        retry: retry ?? (() => transcriptRetry.current(address)),
      })
    },
    [local, reportFailure]
  )

  const currentTaskRunning = currentAddress
    ? runtimeTaskRunning(currentAddress, work, taskRunningByKey)
    : false
  const currentTaskStopping = currentAddress
    ? stoppingTaskKey === runtimeTaskKey(currentAddress)
    : false

  const publishTaskLifecycle = useCallback(() => {
    setTaskRunningByKey(lifecycle.snapshot())
  }, [lifecycle])

  const clearStoppingTask = useCallback((address: RuntimeTaskAddress) => {
    const key = runtimeTaskKey(address)
    stopRequestsRef.current.delete(key)
    setStoppingTaskKey(current => (current === key ? null : current))
  }, [])

  const observeTranscript = useCallback(
    (address: RuntimeTaskAddress, page?: 'older') => {
      const observation = lifecycle.transcriptRequested(address)
      return (transcript: RuntimeTranscriptResponse) => {
        clearFailure(`transcript${page ? '-older' : ''}:${runtimeTaskKey(address)}`)
        if (page) return
        if (
          typeof transcript.running === 'boolean' &&
          lifecycle.transcriptReceived(observation, transcript.running)
        )
          publishTaskLifecycle()
        if (
          transcript.running === false &&
          lifecycle.snapshot().get(runtimeTaskKey(address)) === false
        )
          clearStoppingTask(address)
        if (sameRuntimeAddress(currentAddressRef.current, address) && transcript.title)
          setCurrentTitle(transcript.title)
      }
    },
    [clearStoppingTask, lifecycle, publishTaskLifecycle, clearFailure]
  )

  const {
    messages,
    loading: transcriptLoading,
    historyLoaded,
    hasMoreMessagesBefore,
    loadingMoreMessagesBefore,
    activate: activateTranscript,
    reset: resetTranscript,
    fail: failTranscript,
    rename: renameTranscript,
    dispatchMessages,
    dispatchToAddress,
    readMessages,
    reloadTranscript,
    loadMoreMessagesBefore,
    retainDevices: retainTranscriptDevices,
  } = useMobileTranscript(stream, currentAddressRef, reportTranscriptFailure, observeTranscript)

  const userInput = useMobileUserInput({
    api,
    currentAddress: currentAddressRef,
    readMessages,
    dispatch: dispatchToAddress,
    isRunning: address => runtimeTaskRunning(address, workRef.current, lifecycle.snapshot()),
    modelSelection,
    onTurnStarted: address => {
      lifecycle.executorStarted(address)
      publishTaskLifecycle()
    },
  })

  const persistCache = useCallback(() => {
    if (!activeCache.current.ready) return Promise.resolve()
    const snapshot: RuntimeCacheSnapshot = {
      allDevicesSelected: allDevicesSelectedRef.current,
      devices: deviceInventoryRef.current,
      models: modelsRef.current,
      selectedDeviceId: selectedDeviceIdRef.current,
      workByDevice: workByDeviceRef.current,
    }
    return activeCache.current.cache.write(snapshot)
  }, [])

  const publishSelectedDevice = useCallback(
    (deviceId: string | null, cachedWork?: RuntimeWorkListResponse) => {
      allDevicesSelectedRef.current = false
      setAllDevicesSelected(false)
      selectedDeviceIdRef.current = deviceId
      setSelectedDeviceId(deviceId)
      const nextWork = cachedWork ?? (deviceId ? workByDeviceRef.current[deviceId] : undefined)
      workRef.current = nextWork ?? EMPTY_WORK
      setWork(workRef.current)
      if (nextWork) setLoading(false)
      setSelectedWorkspace(null)
      void persistCache().catch(cause =>
        recordMobileDiagnosticFailure('Failed to cache selected device', cause)
      )
      return nextWork
    },
    [persistCache]
  )

  const publishAllDevices = useCallback(() => {
    allDevicesSelectedRef.current = true
    setAllDevicesSelected(true)
    selectedDeviceIdRef.current = null
    setSelectedDeviceId(null)
    const nextWork = mergeRuntimeWorkForDevices(
      workByDeviceRef.current,
      devicesRef.current.map(device => device.device_id)
    )
    workRef.current = nextWork
    setWork(nextWork)
    setSelectedWorkspace(null)
    void persistCache().catch(cause =>
      recordMobileDiagnosticFailure('Failed to cache all-device scope', cause)
    )
    return nextWork
  }, [persistCache])

  useLayoutEffect(() => {
    if (
      cloudConnection.connected ||
      allDevicesSelectedRef.current ||
      !selectedDeviceIdRef.current ||
      local?.ownsDevice(selectedDeviceIdRef.current)
    )
      return
    // A hidden remote selection must not strand the phone list or new-chat action.
    // Retain its snapshot and the active conversation; no read or restart is triggered.
    const phone = local?.device()
    publishSelectedDevice(phone?.device_id ?? null)
    setLoading(false)
  }, [cloudConnection.connected, local, publishSelectedDevice, selectedDeviceId])

  const { commitDeviceWork, reloadWork, reloadAllWork } = useRuntimeWorkLists({
    local,
    stream,
    workByDeviceRef,
    workRef,
    allDevicesSelectedRef,
    selectedDeviceIdRef,
    devicesRef,
    cloudConnectedRef,
    workRequestRevisionRef,
    lifecycle,
    setWork,
    setLoading,
    persistCache,
    publishTaskLifecycle,
    reportFailure,
    clearFailure,
    emptyWork: EMPTY_WORK,
  })

  const subscribe = useCallback(
    async (address: RuntimeTaskAddress) => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      const unsubscribe = await stream.subscribe(
        address,
        event => {
          if (!sameRuntimeAddress(currentAddressRef.current, address)) return
          dispatchMessages({
            type: 'stream',
            event,
          })
        },
        () => void reloadTranscript(address).catch(readFailureRecorded)
      )
      if (!sameRuntimeAddress(currentAddressRef.current, address)) {
        unsubscribe()
        throw new Error('会话已切换')
      }
      unsubscribeRef.current = unsubscribe
    },
    [dispatchMessages, reloadTranscript, stream]
  )

  transcriptRetry.current = async address => {
    if (sameRuntimeAddress(currentAddressRef.current, address)) await subscribe(address)
    await reloadTranscript(address)
  }

  const applyModels = useCallback((nextModels: UnifiedModel[]) => {
    modelsRef.current = nextModels
    setCloudModels(nextModels)
  }, [])

  const applyDevices = useCallback(
    (inventory: DeviceInfo[]): string | null => {
      const currentInventory = withPhoneLocalDevice(inventory, local?.device())
      deviceInventoryRef.current = currentInventory
      api.clearPluginCatalogs()
      const operableDevices = mobileOperableDevices(currentInventory)
      const operableDeviceIds = operableDevices.map(device => device.device_id)
      retainTranscriptDevices(operableDeviceIds)
      devicesRef.current = operableDevices
      workByDeviceRef.current = runtimeWorkForDevices(workByDeviceRef.current, operableDeviceIds)
      setDevices(operableDevices)
      const current = currentAddressRef.current
      if (current && !operableDeviceIds.includes(current.deviceId)) {
        unsubscribeRef.current?.()
        unsubscribeRef.current = null
        currentAddressRef.current = null
        setCurrentAddress(null)
        setSelectedWorkspace(null)
        resetTranscript()
      }
      if (allDevicesSelectedRef.current) {
        publishAllDevices()
        return null
      }
      const deviceId = selectedOnlineDeviceId(
        operableDevices.filter(
          device => cloudConnectedRef.current || local?.ownsDevice(device.device_id)
        ),
        selectedDeviceIdRef.current
      )
      if (deviceId !== selectedDeviceIdRef.current) publishSelectedDevice(deviceId)
      void persistCache().catch(cause =>
        recordMobileDiagnosticFailure('Failed to cache devices', cause)
      )
      return deviceId
    },
    [
      api,
      local,
      persistCache,
      publishAllDevices,
      publishSelectedDevice,
      resetTranscript,
      retainTranscriptDevices,
    ]
  )

  const previousBackendIdentity = useRef(backendIdentity)
  useLayoutEffect(() => {
    if (previousBackendIdentity.current === backendIdentity) return
    previousBackendIdentity.current = backendIdentity
    clearRemoteFailures()
    for (const [deviceId, revision] of workRequestRevisionRef.current) {
      if (!local?.ownsDevice(deviceId)) workRequestRevisionRef.current.set(deviceId, revision + 1)
    }
    applyModels([])
    // Revoke the old account's remote view before paint, retaining phone-owned work.
    applyDevices([])
  }, [backendIdentity, applyModels, applyDevices, clearRemoteFailures, local])

  const onInitialCloudDevices = useCallback(
    (deviceId: string | null) => {
      if (allDevicesSelectedRef.current)
        void reloadAllWork(local?.status.deviceId ?? undefined).catch(readFailureRecorded)
      else if (deviceId && !local?.ownsDevice(deviceId))
        void reloadWork(deviceId).catch(readFailureRecorded)
    },
    [local, reloadAllWork, reloadWork]
  )
  const { refreshDevices } = useRuntimeCloudConnection({
    api,
    stream,
    identity: backendIdentity,
    connection: cloudConnection,
    cacheReady: hydratedCache === cache,
    applyDevices,
    applyModels,
    onInitialDevices: onInitialCloudDevices,
    reportFailure,
    clearFailure,
  })
  const { refresh, refreshing } = useRuntimeDeviceRefresh({
    local,
    backendIdentity,
    inventory: deviceInventoryRef,
    selectedDeviceId: selectedDeviceIdRef,
    allDevicesSelected: allDevicesSelectedRef,
    applyDevices,
    reloadWork,
    reloadAllWork,
  })

  useEffect(() => {
    setTaskRunningByKey(lifecycle.snapshot())
  }, [lifecycle])

  useRuntimeLifecycleEvents({
    stream,
    lifecycle,
    currentAddressRef,
    workByDeviceRef,
    setCurrentAddress,
    commitDeviceWork,
    publishTaskLifecycle,
    reloadTranscript,
  })

  const cacheRefs = useMemo(
    () => ({
      selectionRevisionRef,
      deviceInventoryRef,
      devicesRef,
      modelsRef,
      workByDeviceRef,
      selectedDeviceIdRef,
      currentAddressRef,
      workRef,
      allDevicesSelectedRef,
      cloudConnectedRef,
    }),
    []
  )
  useRuntimeCacheHydration({
    cache,
    cacheHydration,
    backendIdentity,
    local,
    refs: cacheRefs,
    applyModels,
    setDevices,
    publishAllDevices,
    publishSelectedDevice,
    setError,
    setLoading,
    persistCache,
    lifecycle,
    publishTaskLifecycle,
    onHydrated: setHydratedCache,
  })

  useEffect(
    () => () => {
      unsubscribeRef.current?.()
      stream.dispose()
    },
    [stream]
  )

  const selectDevice = useCallback(
    (deviceId: string) => {
      selectionRevisionRef.current += 1
      if (!allDevicesSelectedRef.current && deviceId === selectedDeviceIdRef.current) return
      publishSelectedDevice(deviceId)
      void reloadWork(deviceId).catch(readFailureRecorded)
    },
    [publishSelectedDevice, reloadWork]
  )

  const selectAllDevices = useCallback(() => {
    selectionRevisionRef.current += 1
    if (allDevicesSelectedRef.current) return
    const hasCachedWork = devicesRef.current.some(device =>
      Boolean(workByDeviceRef.current[device.device_id])
    )
    publishAllDevices()
    setLoading(!hasCachedWork)
    void reloadAllWork()
      .catch(readFailureRecorded)
      .finally(() => {
        if (allDevicesSelectedRef.current) setLoading(false)
      })
  }, [publishAllDevices, reloadAllWork])

  const openConversation = useCallback(
    async (item: ConversationItem) => {
      selectionRevisionRef.current += 1
      setError(null)
      currentAddressRef.current = item.address
      setCurrentAddress(item.address)
      setCurrentTitle(activateTranscript(item.address) || item.title)
      if (!allDevicesSelectedRef.current) publishSelectedDevice(item.address.deviceId, work)
      const workspace = allWorkspaces(work).find(
        candidate =>
          candidate.deviceId === item.address.deviceId &&
          candidate.workspacePath === item.address.workspacePath
      )
      setSelectedWorkspace(workspace ?? null)
      try {
        await subscribe(item.address)
        await reloadTranscript(item.address)
      } catch (cause) {
        failTranscript(item.address, messageFrom(cause))
      }
    },
    [activateTranscript, failTranscript, publishSelectedDevice, reloadTranscript, subscribe, work]
  )

  const startNewConversation = useCallback(
    (workspace?: RuntimeDeviceWorkspace) => {
      selectionRevisionRef.current += 1
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      currentAddressRef.current = null
      setCurrentAddress(null)
      setCurrentTitle(workspace?.label || '新会话')
      resetTranscript()
      setLoading(false)
      const deviceId =
        worktreeWorkspaceDeviceId(workspace) ??
        selectedOnlineDeviceId(
          mobileCreatableDevices(devicesRef.current),
          selectedDeviceIdRef.current
        )
      if (deviceId) {
        publishSelectedDevice(deviceId)
      }
      setSelectedWorkspace(workspace ?? null)
    },
    [publishSelectedDevice, resetTranscript]
  )

  const send = useCallback(
    async (rawMessage: string, options?: NewConversationOptions): Promise<boolean> => {
      const message = rawMessage.trim()
      if (!message || sending || currentTaskRunning) return false
      const userMessageId = Crypto.randomUUID()
      let sendTransition: RuntimeSendTransition | null = null
      let provisionalAddress: RuntimeTaskAddress | null = null
      dispatchMessages({
        type: 'optimistic-user',
        id: userMessageId,
        content: message,
        attachments: options?.attachments,
        createdAt: Date.now(),
      })
      setSending(true)
      setError(null)

      try {
        if (!selectedModel || !modelSelection) throw new Error('请选择可用模型')
        if (currentAddressRef.current) {
          const address = currentAddressRef.current
          if (options?.pursueGoal) {
            const goalResponse = await api.setGoal(address, message)
            if (!goalResponse.accepted) throw new Error('目标创建失败')
          }
          sendTransition = lifecycle.sendRequested(address)
          publishTaskLifecycle()
          await subscribe(address)
          const response = await api.sendMessage(
            address,
            message,
            userMessageId,
            modelSelection,
            options?.attachmentIds
          )
          if (!response.accepted) throw new Error(response.error || '发送未被执行器接受')
          dispatchToAddress(address, { type: 'user-delivered', id: userMessageId })
          return true
        }

        const requestedDeviceId =
          worktreeWorkspaceDeviceId(selectedWorkspace) ??
          selectedOnlineDeviceId(mobileCreatableDevices(devicesRef.current), selectedDeviceId)
        if (!requestedDeviceId) throw new Error('没有可用的在线执行器')
        if (
          !mobileCreatableDevices(devicesRef.current).some(
            device => device.device_id === requestedDeviceId
          )
        ) {
          throw new Error('此设备当前不支持新建会话，请检查电脑端开关和版本')
        }
        const deviceId = requestedDeviceId
        const taskId = createRuntimeTaskId()
        const standaloneChatWorkspace =
          !selectedWorkspace &&
          devicesRef.current.some(
            device => device.device_id === deviceId && device.device_type === 'app'
          )
        const workspacePath = selectedWorkspace
          ? selectedWorkspace.workspacePath
          : standaloneChatWorkspace
            ? undefined
            : await createConversationWorkspace(api, deviceId, message, taskId)
        provisionalAddress = {
          deviceId,
          taskId,
          runtime: 'codex',
          runtimeHandle: { modelSelection },
          workspacePath,
          workspaceKind:
            options?.executionMode === 'git_worktree'
              ? 'worktree'
              : (selectedWorkspace?.workspaceKind ?? 'chat'),
        }
        currentAddressRef.current = provisionalAddress
        setCurrentAddress(provisionalAddress)
        activateTranscript(provisionalAddress, { adoptDraft: true })
        setCurrentTitle(titleFrom(message))
        sendTransition = lifecycle.sendRequested(provisionalAddress)
        publishTaskLifecycle()
        await subscribe(provisionalAddress)

        const response = await api.createConversation({
          schemaVersion: 2,
          deviceId,
          ...(workspacePath ? { workspacePath } : {}),
          ...(standaloneChatWorkspace ? { standaloneChatWorkspace: true } : {}),
          taskId,
          runtime: 'codex',
          message,
          clientUserMessageId: userMessageId,
          title: titleFrom(message),
          modelId: modelSelection.modelName,
          modelType: selectedModel.type,
          modelOptions: modelSelection.options ?? {},
          ...(options?.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
          ...(options?.pursueGoal
            ? {
                initialGoal: {
                  objective: message,
                  status: 'active' as const,
                  tokenBudget: null,
                },
              }
            : {}),
          ...(options?.executionMode === 'git_worktree'
            ? {
                execution: {
                  workspace: {
                    source: 'git_worktree',
                    ...(options.worktreeBranch?.trim()
                      ? { branch: options.worktreeBranch.trim() }
                      : {}),
                  },
                },
              }
            : {}),
        })
        if (!response.accepted) throw new Error(response.error || '新会话未被执行器接受')
        const resolvedAddress = {
          ...provisionalAddress,
          taskId: response.taskId,
          workspacePath: response.workspacePath,
        }
        if (response.taskId !== taskId) {
          renameTranscript(provisionalAddress, resolvedAddress)
          recordMobileTaskAddressRename(provisionalAddress, resolvedAddress)
          sendTransition = lifecycle.renameSend(sendTransition, resolvedAddress)
          publishTaskLifecycle()
        }
        if (sameRuntimeAddress(currentAddressRef.current, provisionalAddress)) {
          provisionalAddress = resolvedAddress
          currentAddressRef.current = resolvedAddress
          setCurrentAddress(resolvedAddress)
          activateTranscript(resolvedAddress)
          if (response.taskId !== taskId) {
            try {
              await subscribe(resolvedAddress)
              await reloadTranscript(resolvedAddress)
            } catch (cause) {
              failTranscript(resolvedAddress, messageFrom(cause))
            }
          }
        }
        void reloadWork(resolvedAddress.deviceId).catch(readFailureRecorded)
        dispatchToAddress(resolvedAddress, { type: 'user-delivered', id: userMessageId })
        return true
      } catch (cause) {
        if (sendTransition && lifecycle.sendRejected(sendTransition)) {
          recordMobileTaskOutcome(sendTransition.address, 'runtime.task.failed')
          publishTaskLifecycle()
        }
        if (
          sendTransition &&
          (!currentAddressRef.current ||
            runtimeTaskKey(currentAddressRef.current) !== sendTransition.key)
        )
          return false
        if (
          provisionalAddress &&
          currentAddressRef.current?.deviceId === provisionalAddress.deviceId &&
          currentAddressRef.current.taskId === provisionalAddress.taskId
        ) {
          unsubscribeRef.current?.()
          unsubscribeRef.current = null
          currentAddressRef.current = null
          setCurrentAddress(null)
        }
        const messageText = messageFrom(cause)
        dispatchMessages({
          type: 'fail',
          id: `assistant-${currentAddressRef.current?.taskId ?? userMessageId}`,
          error: messageText,
        })
        setError(messageText)
        return false
      } finally {
        setSending(false)
      }
    },
    [
      api,
      activateTranscript,
      lifecycle,
      publishTaskLifecycle,
      failTranscript,
      reloadTranscript,
      reloadWork,
      renameTranscript,
      selectedDeviceId,
      selectedModel,
      selectedModelOptions,
      modelSelection,
      permissionMode,
      selectedWorkspace,
      sending,
      subscribe,
      stream,
      currentTaskRunning,
      dispatchMessages,
      dispatchToAddress,
    ]
  )

  const stop = useCallback(async (): Promise<boolean> => {
    const address = currentAddressRef.current
    if (!address || !runtimeTaskRunning(address, work, taskRunningByKey)) return false
    const key = runtimeTaskKey(address)
    if (stopRequestsRef.current.has(key)) return false

    stopRequestsRef.current.add(key)
    setStoppingTaskKey(key)
    setError(null)
    try {
      const response = await api.cancelTask(address)
      if (!response.accepted) throw new Error(response.error || '停止当前回复失败')
      void reloadWork(address.deviceId).catch(readFailureRecorded)
      return true
    } catch (cause) {
      clearStoppingTask(address)
      setError(messageFrom(cause))
      return false
    }
  }, [api, clearStoppingTask, reloadWork, taskRunningByKey, work])

  const uploadAttachment = useCallback(
    async (asset: RuntimeUploadAsset) => {
      try {
        setError(null)
        return await api.uploadAttachment(
          asset,
          currentAddressRef.current?.deviceId ??
            worktreeWorkspaceDeviceId(selectedWorkspace) ??
            selectedDeviceId ??
            undefined
        )
      } catch (cause) {
        setError(messageFrom(cause))
        throw cause
      }
    },
    [api, selectedDeviceId, selectedWorkspace]
  )

  const loadComposerApps = useCallback(async () => {
    const deviceId =
      currentAddressRef.current?.deviceId ??
      worktreeWorkspaceDeviceId(selectedWorkspace) ??
      selectedDeviceId ??
      selectedOnlineDeviceId(devicesRef.current, null)
    if (!deviceId) throw new Error('请先选择在线 Executor')
    if (local?.ownsDevice(deviceId))
      return api.listLocalComposerApps(
        currentAddressRef.current ?? {
          deviceId,
          scope: 'workspace',
          workspacePath: selectedWorkspace?.workspacePath ?? null,
        }
      )
    const installedPlugins = await api.listInstalledPlugins(deviceId)
    return composerApps(installedPlugins)
  }, [api, local, selectedDeviceId, selectedWorkspace])

  const projectActions = useProjectActions({
    api,
    reloadWork,
    onRemoved: project => {
      setSelectedWorkspace(current =>
        current &&
        project.deviceWorkspaces.some(
          workspace =>
            workspace.deviceId === current.deviceId &&
            workspace.workspacePath === current.workspacePath
        )
          ? null
          : current
      )
    },
  })

  const createProject = useMobileProjectCreation({
    api,
    devices: devicesRef,
    publishSelectedDevice,
    reloadWork,
    startNewConversation,
    setLoading,
    setError,
  })

  const conversations = useMemo(
    () => flattenConversations(work, taskRunningByKey),
    [work, taskRunningByKey]
  )
  const visibleDevices = devices.filter(
    device => cloudConnection.connected || local?.ownsDevice(device.device_id)
  )
  const listDevices = visibleDevices.filter(device => device.status !== 'offline')
  const listSnapshotReady = allDevicesSelected
    ? listDevices.length > 0 &&
      listDevices.every(device => Boolean(workByDeviceRef.current[device.device_id]))
    : Boolean(selectedDeviceId && workByDeviceRef.current[selectedDeviceId])
  useEffect(() => {
    recordMobileDiagnostic('[MobileStartup] List prerequisites', () => ({
      cacheReady: hydratedCache === cache,
      phoneState: local?.status.state ?? 'unavailable',
      cloudConnected: cloudConnection.connected,
      hasSelection: Boolean(selectedDeviceId) || allDevicesSelected,
      snapshotReady: listSnapshotReady,
      loading,
      devices: visibleDevices.length,
      conversations: conversations.length,
      failures: failures.length,
    }))
  }, [
    hydratedCache,
    cache,
    local?.status.state,
    cloudConnection.connected,
    selectedDeviceId,
    allDevicesSelected,
    listSnapshotReady,
    loading,
    visibleDevices.length,
    conversations.length,
    failures.length,
  ])
  const conversationActions = useConversationActions({
    api,
    work,
    currentAddress: currentAddressRef,
    reloadWork,
    setCurrentTitle,
    clearCurrentConversation: startNewConversation,
    setError,
    setConnectionError: readFailureRecorded,
  })
  const fileTarget = useMemo(
    () => resolveMobileWorkspaceFileTarget(currentAddress, work, selectedWorkspace),
    [currentAddress, work, selectedWorkspace]
  )

  return {
    ...conversationActions,
    api,
    fileTarget,
    work,
    taskRunningByKey,
    devices: visibleDevices,
    listSnapshotReady,
    cloudConnected: cloudConnection.connected,
    failures,
    retryFailure,
    refreshDevices,
    conversations,
    messages,
    currentAddress,
    currentTitle,
    selectedWorkspace,
    selectedDeviceId,
    allDevicesSelected,
    models,
    selectedModel,
    selectedModelOptions,
    permissionMode,
    loading,
    conversationLoading: transcriptLoading,
    historyLoaded,
    hasMoreMessagesBefore,
    loadingMoreMessagesBefore,
    refreshing,
    sending,
    running: currentTaskRunning,
    stopping: currentTaskStopping,
    error,
    connectionError,
    refresh,
    loadMoreMessagesBefore,
    openConversation,
    startNewConversation,
    selectDevice,
    selectAllDevices,
    selectWorkspace: workspace => {
      selectionRevisionRef.current += 1
      const deviceId = worktreeWorkspaceDeviceId(workspace)
      if (deviceId && (deviceId !== selectedDeviceIdRef.current || allDevicesSelectedRef.current))
        publishSelectedDevice(deviceId)
      setSelectedWorkspace(workspace)
    },
    selectModel: deviceModels.selectModel,
    loadModels: deviceModels.loadModels,
    loadLocalModels,
    modelsLoading: deviceModels.modelsLoading,
    modelsError: deviceModels.modelsError,
    selectPermissionMode,
    send,
    stop,
    respondToUserInput: userInput.respondToUserInput,
    skipUserInput: userInput.skipUserInput,
    uploadAttachment,
    loadComposerApps,
    createProject,
    ...projectActions,
    refreshWork: reloadWork,
    clearError: () => setError(null),
  }
}
