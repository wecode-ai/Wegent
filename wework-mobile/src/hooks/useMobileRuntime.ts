import * as Crypto from 'expo-crypto'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { composerApps } from '@/domain/composerApps'
import { withPhoneLocalDevice } from '@/domain/withPhoneLocalDevice'
import {
  mobileCreatableDevices,
  mobileOperableDevices,
  selectedOnlineDeviceId,
} from '@/domain/deviceOrdering'
import { continuationSelection, executionFields } from '@/domain/modelSelection'
import { resolveMobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import {
  isRunningRuntimeEvent,
  isTerminalRuntimeEvent,
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
import { useWorkspaceGitRef } from './useWorkspaceGitRef'
import { useDeviceModels } from './useDeviceModels'
import { useRuntimeDeviceRefresh } from './useRuntimeDeviceRefresh'
import { useMobileUserInput } from './useMobileUserInput'
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
const noListRefresh = () => {}
export function useMobileRuntime(
  config: RuntimeSessionConfig | null,
  userId: number,
  localOptions?: MobileLocalRuntimeOptions
): MobileRuntimeState {
  const deviceInventoryRef = useRef<DeviceInfo[]>([])
  const { api, stream, cache, local } = useMobileRuntimeSession(
    config,
    userId,
    localOptions,
    deviceInventoryRef
  )
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
  const deviceModels = useDeviceModels(
    api,
    devices.find(device => device.device_id === (currentAddress?.deviceId ?? selectedDeviceId)),
    cloudModels,
    backendIdentity,
    local?.status.generation
  )
  const { models, selectedModel, selectedModelOptions } = deviceModels
  const loadLocalModels = useCallback(
    () => deviceModels.loadDeviceModels(local?.device(), true),
    [deviceModels.loadDeviceModels, local]
  )
  useEffect(() => {
    if (
      local?.status.state === 'running' &&
      local.ownsDevice(currentAddress?.deviceId ?? selectedDeviceId ?? undefined)
    )
      void deviceModels.loadModels()
  }, [
    local,
    local?.status.generation,
    local?.status.state,
    currentAddress?.deviceId,
    selectedDeviceId,
    deviceModels.loadModels,
  ])
  const { permissionMode, selectPermissionMode } = useRuntimePermissionPreference()
  const gitRef = useWorkspaceGitRef(api, !currentAddress, selectedWorkspace, devices)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [stoppingTaskKey, setStoppingTaskKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
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
    (address: RuntimeTaskAddress) => {
      const observation = lifecycle.transcriptRequested(address)
      return (transcript: RuntimeTranscriptResponse) => {
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
    [clearStoppingTask, lifecycle, publishTaskLifecycle]
  )

  const {
    messages,
    loading: transcriptLoading,
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
  } = useMobileTranscript(stream, currentAddressRef, setConnectionError, observeTranscript)

  const userInput = useMobileUserInput({
    api,
    currentAddress: currentAddressRef,
    readMessages,
    dispatch: dispatchToAddress,
    isRunning: address => runtimeTaskRunning(address, workRef.current, lifecycle.snapshot()),
    modelSelection: selectedModel
      ? continuationSelection(
          executionFields(selectedModel, { ...selectedModelOptions, permissionMode })
        )
      : null,
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
      void persistCache().catch(cause => console.warn('Failed to cache selected device', cause))
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
    void persistCache().catch(cause => console.warn('Failed to cache all-device scope', cause))
    return nextWork
  }, [persistCache])

  const nextWorkRevision = useCallback((deviceId: string) => {
    const next = (workRequestRevisionRef.current.get(deviceId) ?? 0) + 1
    workRequestRevisionRef.current.set(deviceId, next)
    return next
  }, [])

  const commitDeviceWork = useCallback(
    async (deviceId: string, nextWork: RuntimeWorkListResponse) => {
      workByDeviceRef.current = { ...workByDeviceRef.current, [deviceId]: nextWork }
      if (allDevicesSelectedRef.current) {
        const merged = mergeRuntimeWorkForDevices(
          workByDeviceRef.current,
          devicesRef.current.map(device => device.device_id)
        )
        workRef.current = merged
        setWork(merged)
        if (lifecycle.syncWork(merged)) publishTaskLifecycle()
        setLoading(false)
      } else if (selectedDeviceIdRef.current === deviceId) {
        workRef.current = nextWork
        setWork(nextWork)
        if (lifecycle.syncWork(nextWork)) publishTaskLifecycle()
      }
      void persistCache().catch(cause => console.warn('Failed to cache device work', cause))
    },
    [lifecycle, persistCache, publishTaskLifecycle]
  )

  const reloadWork = useCallback(
    async (requestedDeviceId?: string | null) => {
      const deviceId = requestedDeviceId ?? selectedDeviceIdRef.current
      if (!deviceId) return EMPTY_WORK
      const revision = nextWorkRevision(deviceId)
      const deviceName = devicesRef.current.find(device => device.device_id === deviceId)?.name
      if (selectedDeviceIdRef.current === deviceId) setLoading(!workByDeviceRef.current[deviceId])
      try {
        const nextWork = await stream.listWork(deviceId, deviceName)
        if (workRequestRevisionRef.current.get(deviceId) !== revision) return nextWork
        if (!devicesRef.current.some(device => device.device_id === deviceId)) return nextWork
        await commitDeviceWork(deviceId, nextWork)
        return nextWork
      } finally {
        if (
          workRequestRevisionRef.current.get(deviceId) === revision &&
          selectedDeviceIdRef.current === deviceId
        )
          setLoading(false)
      }
    },
    [commitDeviceWork, nextWorkRevision, stream]
  )

  const reloadAllWork = useCallback(async () => {
    const onlineDevices = devicesRef.current.filter(device => device.status !== 'offline')
    const results = await Promise.allSettled(
      onlineDevices.map(device => reloadWork(device.device_id))
    )
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failed) throw failed.reason
  }, [reloadWork])

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
        () => void reloadTranscript(address).catch(cause => setConnectionError(messageFrom(cause)))
      )
      if (!sameRuntimeAddress(currentAddressRef.current, address)) {
        unsubscribe()
        throw new Error('会话已切换')
      }
      unsubscribeRef.current = unsubscribe
    },
    [dispatchMessages, reloadTranscript, stream]
  )

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
      const deviceId = selectedOnlineDeviceId(operableDevices, selectedDeviceIdRef.current)
      if (deviceId !== selectedDeviceIdRef.current) publishSelectedDevice(deviceId)
      void persistCache().catch(cause => console.warn('Failed to cache devices', cause))
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
  const hydratedBackendIdentity = useRef(backendIdentity)
  const hasHydratedCache = useRef(false)
  useLayoutEffect(() => {
    if (previousBackendIdentity.current === backendIdentity) return
    previousBackendIdentity.current = backendIdentity
    applyModels([])
    // Revoke the old account's remote view before paint, retaining phone-owned work.
    applyDevices([])
  }, [backendIdentity, applyModels, applyDevices])

  const reloadRelated = useCallback(async () => {
    const response = await api.listModels()
    if (previousBackendIdentity.current !== backendIdentity) return
    applyModels(response.data)
    const address = currentAddressRef.current
    if (address) {
      await subscribe(address)
      await reloadTranscript(address)
    }
  }, [api, applyModels, subscribe, reloadTranscript, backendIdentity])
  const { refreshDevices, refresh, refreshing } = useRuntimeDeviceRefresh({
    api,
    sessionIdentity: backendIdentity,
    local,
    inventory: deviceInventoryRef,
    selectedDeviceId: selectedDeviceIdRef,
    allDevicesSelected: allDevicesSelectedRef,
    applyDevices,
    reloadWork,
    reloadAllWork,
    reloadRelated,
    setConnectionError,
  })

  useEffect(() => {
    setTaskRunningByKey(lifecycle.snapshot())
  }, [lifecycle])

  useEffect(
    () =>
      stream.subscribeLifecycle((address, event) => {
        if (isRunningRuntimeEvent(event.name) && lifecycle.executorStarted(address)) {
          publishTaskLifecycle()
        }
        if (isTerminalRuntimeEvent(event.name)) {
          const current = currentAddressRef.current
          if (current && runtimeTaskKey(current) === runtimeTaskKey(address)) {
            void reloadTranscript(address).catch(cause => setConnectionError(messageFrom(cause)))
          }
        }
      }, noListRefresh),
    [lifecycle, publishTaskLifecycle, reloadTranscript, stream]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const selectionRevision = selectionRevisionRef.current
      const cached = await cache.read().catch(cause => {
        if (!cancelled) setError(messageFrom(cause))
        return null
      })
      if (cancelled) return
      if (cached) {
        const backendTransition =
          hasHydratedCache.current && hydratedBackendIdentity.current !== backendIdentity
        hasHydratedCache.current = true
        hydratedBackendIdentity.current = backendIdentity
        // A storage snapshot must not replace a choice the user has already made.
        const selectionUnchanged = selectionRevision === selectionRevisionRef.current
        const inventory =
          selectionUnchanged || !deviceInventoryRef.current.length
            ? cached.devices
            : deviceInventoryRef.current
        deviceInventoryRef.current = withPhoneLocalDevice(inventory, local?.device())
        const cachedDevices = mobileOperableDevices(deviceInventoryRef.current)
        devicesRef.current = cachedDevices
        modelsRef.current = cached.models
        const retainedLocalWork = Object.fromEntries(
          Object.entries(workByDeviceRef.current).filter(([id]) => local?.ownsDevice(id))
        )
        workByDeviceRef.current = runtimeWorkForDevices(
          {
            ...cached.workByDevice,
            ...retainedLocalWork,
            ...(!selectionUnchanged ? workByDeviceRef.current : {}),
          },
          cachedDevices.map(device => device.device_id)
        )
        setDevices(cachedDevices)
        applyModels(cached.models)
        const cachedDeviceId = selectedOnlineDeviceId(cachedDevices, cached.selectedDeviceId)
        const retainedLocalSelection =
          local?.ownsDevice(selectedDeviceIdRef.current ?? undefined) &&
          (backendTransition ||
            selectionRevision > 0 ||
            local?.ownsDevice(currentAddressRef.current?.deviceId))
        const cachedWork =
          !selectionUnchanged || retainedLocalSelection
            ? workRef.current
            : cached.allDevicesSelected
              ? publishAllDevices()
              : publishSelectedDevice(
                  cachedDeviceId,
                  cachedDeviceId ? cached.workByDevice[cachedDeviceId] : undefined
                )
        const hasCachedWork = allDevicesSelectedRef.current
          ? cachedDevices.some(device => Boolean(workByDeviceRef.current[device.device_id]))
          : Boolean(
              selectedDeviceIdRef.current && workByDeviceRef.current[selectedDeviceIdRef.current]
            )
        if (cachedWork && lifecycle.syncWork(cachedWork)) publishTaskLifecycle()
        setLoading(!hasCachedWork)
        cacheHydration.ready = true
        void persistCache().catch(cause => console.warn('Failed to cache restored state', cause))
      }

      void api
        .listModels()
        .then(response => {
          if (cancelled) return
          applyModels(response.data)
          void persistCache().catch(cause => console.warn('Failed to cache models', cause))
        })
        .catch(cause => {
          if (!cancelled && modelsRef.current.length === 0) setConnectionError(messageFrom(cause))
        })

      let deviceId = selectedDeviceIdRef.current
      try {
        deviceId = await refreshDevices()
      } catch (cause) {
        if (!cancelled) setConnectionError(messageFrom(cause))
      }
      if (cancelled) return

      if (allDevicesSelectedRef.current) {
        void reloadAllWork()
          .catch(cause => {
            if (!cancelled) setConnectionError(messageFrom(cause))
          })
          .finally(() => {
            if (!cancelled && allDevicesSelectedRef.current) setLoading(false)
          })
      } else if (deviceId) {
        // Native startup is read by its availability owner, before discovery.
        if (local?.ownsDevice(deviceId)) {
          if (local.status.state !== 'running') setLoading(false)
          return
        }
        void reloadWork(deviceId).catch(cause => {
          if (!cancelled) setConnectionError(messageFrom(cause))
        })
      } else {
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    api,
    applyModels,
    cache,
    cacheHydration,
    lifecycle,
    local,
    persistCache,
    publishSelectedDevice,
    publishAllDevices,
    publishTaskLifecycle,
    refreshDevices,
    reloadAllWork,
    reloadWork,
    stream,
  ])

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
      void reloadWork(deviceId).catch(cause => setConnectionError(messageFrom(cause)))
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
      .catch(cause => setConnectionError(messageFrom(cause)))
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
        workspace?.deviceId ??
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
        if (!selectedModel) throw new Error('请选择可用模型')
        deviceModels.selectModel(selectedModel, selectedModelOptions)
        const model = executionFields(selectedModel, {
          ...selectedModelOptions,
          permissionMode,
        })
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
            continuationSelection(model),
            options?.attachmentIds
          )
          if (!response.accepted) throw new Error(response.error || '发送未被执行器接受')
          dispatchToAddress(address, { type: 'user-delivered', id: userMessageId })
          return true
        }

        const requestedDeviceId =
          selectedWorkspace?.deviceId ??
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
          workspacePath,
          workspaceKind: options?.worktreeBranch
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
          ...model,
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
          ...(options?.worktreeBranch
            ? {
                execution: {
                  workspace: { source: 'git_worktree', branch: options.worktreeBranch },
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
        void reloadWork(resolvedAddress.deviceId).catch(cause =>
          setConnectionError(messageFrom(cause))
        )
        dispatchToAddress(resolvedAddress, { type: 'user-delivered', id: userMessageId })
        return true
      } catch (cause) {
        if (sendTransition && lifecycle.sendRejected(sendTransition)) publishTaskLifecycle()
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
      void reloadWork(address.deviceId).catch(cause => setConnectionError(messageFrom(cause)))
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
            selectedWorkspace?.deviceId ??
            selectedDeviceId ??
            undefined
        )
      } catch (cause) {
        setError(messageFrom(cause))
        throw cause
      }
    },
    [api, selectedDeviceId, selectedWorkspace?.deviceId]
  )

  const loadComposerApps = useCallback(async () => {
    const deviceId =
      currentAddressRef.current?.deviceId ??
      selectedWorkspace?.deviceId ??
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
  const conversationActions = useConversationActions({
    api,
    work,
    currentAddress: currentAddressRef,
    reloadWork,
    setCurrentTitle,
    clearCurrentConversation: startNewConversation,
    setError,
    setConnectionError,
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
    devices,
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
    gitRef,
    loading,
    conversationLoading: transcriptLoading,
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
    clearError: () => setError(null),
  }
}
