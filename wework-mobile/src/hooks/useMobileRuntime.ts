import * as Crypto from 'expo-crypto'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AppState } from 'react-native'

import { chatReducer } from '@/domain/chatReducer'
import { composerApps } from '@/domain/composerApps'
import { mobileOperableDevices, selectedOnlineDeviceId } from '@/domain/deviceOrdering'
import {
  continuationSelection,
  defaultModel,
  defaultModelOptions,
  executionFields,
} from '@/domain/modelSelection'
import {
  isRunningRuntimeEvent,
  isTerminalRuntimeEvent,
  RuntimeTaskLifecycleProjection,
  runtimeTaskKey,
  shouldReloadRuntimeWork,
  type RuntimeSendTransition,
} from '@/domain/runtimeTaskLifecycle'
import { createConversationWorkspace } from '@/domain/runtimeConversationWorkspace'
import {
  allWorkspaces,
  flattenConversations,
  mergeRuntimeWorkForDevices,
  runtimeWorkContainsTask,
  runtimeWorkForDevices,
} from '@/domain/work'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import { RuntimeApi } from '@/services/runtimeApi'
import { MobileRuntimeCache, type RuntimeCacheSnapshot } from '@/services/runtimeCache'
import {
  DEFAULT_RUNTIME_PERMISSION_MODE,
  loadRuntimePermissionMode,
  saveRuntimePermissionMode,
  type RuntimePermissionMode,
} from '@/services/runtimePermissionPreference'
import { RuntimeStream } from '@/services/runtimeStream'
import { RuntimeWorkInvalidator } from '@/services/runtimeWorkInvalidator'
import type {
  ChatMessage,
  ConversationItem,
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
  ModelOptions,
  RuntimeAttachment,
  RuntimeComposerApp,
  RuntimeUploadAsset,
} from '@/types/runtime'

const EMPTY_WORK: RuntimeWorkListResponse = {
  projects: [],
  chats: [],
  totalTasks: 0,
}

export interface MobileRuntimeState {
  work: RuntimeWorkListResponse
  devices: DeviceInfo[]
  conversations: ConversationItem[]
  messages: ChatMessage[]
  currentAddress: RuntimeTaskAddress | null
  currentTitle: string
  selectedWorkspace: RuntimeDeviceWorkspace | null
  selectedDeviceId: string | null
  allDevicesSelected: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  permissionMode: RuntimePermissionMode
  gitRef: string | null
  loading: boolean
  hasMoreMessagesBefore: boolean
  loadingMoreMessagesBefore: boolean
  refreshing: boolean
  sending: boolean
  running: boolean
  stopping: boolean
  error: string | null
  refresh: () => Promise<void>
  loadMoreMessagesBefore: () => Promise<void>
  openConversation: (item: ConversationItem) => Promise<void>
  startNewConversation: (workspace?: RuntimeDeviceWorkspace) => void
  selectDevice: (deviceId: string) => void
  selectAllDevices: () => void
  selectWorkspace: (workspace: RuntimeDeviceWorkspace | null) => void
  selectModel: (model: UnifiedModel, options?: ModelOptions) => void
  selectPermissionMode: (mode: RuntimePermissionMode) => void
  send: (message: string, options?: NewConversationOptions) => Promise<boolean>
  stop: () => Promise<boolean>
  uploadAttachment: (asset: RuntimeUploadAsset) => Promise<RuntimeAttachment>
  loadComposerApps: () => Promise<RuntimeComposerApp[]>
  createProject: (input: { deviceId: string; workspacePath: string; name: string }) => Promise<void>
  clearError: () => void
}

export interface NewConversationOptions {
  worktreeBranch?: string
  attachmentIds?: number[]
  pursueGoal?: boolean
}

export function useMobileRuntime(config: RuntimeSessionConfig, userId: number): MobileRuntimeState {
  const api = useMemo(() => new RuntimeApi(config), [config])
  const stream = useMemo(() => new RuntimeStream(config), [config])
  const cache = useMemo(() => new MobileRuntimeCache(config.apiBaseUrl, userId), [config, userId])
  const lifecycle = useMemo(() => new RuntimeTaskLifecycleProjection(), [api])
  const [work, setWork] = useState(EMPTY_WORK)
  const workRef = useRef<RuntimeWorkListResponse>(EMPTY_WORK)
  const [taskRunningByKey, setTaskRunningByKey] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  )
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [messages, dispatchMessages] = useReducer(chatReducer, [])
  const [currentAddress, setCurrentAddress] = useState<RuntimeTaskAddress | null>(null)
  const [currentTitle, setCurrentTitle] = useState('新会话')
  const [selectedWorkspace, setSelectedWorkspace] = useState<RuntimeDeviceWorkspace | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [allDevicesSelected, setAllDevicesSelected] = useState(false)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModel, setSelectedModel] = useState<UnifiedModel | null>(null)
  const [selectedModelOptions, setSelectedModelOptions] = useState<ModelOptions>({})
  const [permissionMode, setPermissionMode] = useState<RuntimePermissionMode>(
    DEFAULT_RUNTIME_PERMISSION_MODE
  )
  const [gitRef, setGitRef] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasMoreMessagesBefore, setHasMoreMessagesBefore] = useState(false)
  const [loadingMoreMessagesBefore, setLoadingMoreMessagesBefore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [sending, setSending] = useState(false)
  const [stoppingTaskKey, setStoppingTaskKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const currentAddressRef = useRef<RuntimeTaskAddress | null>(null)
  const workRequestRevisionRef = useRef(new Map<string, number>())
  const devicesRef = useRef<DeviceInfo[]>([])
  const modelsRef = useRef<UnifiedModel[]>([])
  const selectedDeviceIdRef = useRef<string | null>(null)
  const allDevicesSelectedRef = useRef(false)
  const workByDeviceRef = useRef<Record<string, RuntimeWorkListResponse>>({})
  const refreshingRef = useRef(false)
  const stopRequestsRef = useRef(new Set<string>())
  const transcriptBeforeCursorRef = useRef<string | null>(null)
  const loadingMoreMessagesBeforeRef = useRef(false)
  const transcriptPaginationRevisionRef = useRef(0)

  const currentTaskRunning = currentAddress
    ? runtimeTaskRunning(currentAddress, work, taskRunningByKey)
    : false
  const currentTaskStopping = currentAddress
    ? stoppingTaskKey === runtimeTaskKey(currentAddress)
    : false

  useEffect(() => {
    let active = true
    void loadRuntimePermissionMode()
      .then(stored => {
        if (active) setPermissionMode(stored)
      })
      .catch(cause => console.warn('Failed to load runtime permission preference', cause))
    return () => {
      active = false
    }
  }, [])

  const selectPermissionMode = useCallback((mode: RuntimePermissionMode) => {
    setPermissionMode(mode)
    void saveRuntimePermissionMode(mode).catch(cause =>
      console.warn('Failed to save runtime permission preference', cause)
    )
  }, [])

  const publishTaskLifecycle = useCallback(() => {
    setTaskRunningByKey(lifecycle.snapshot())
  }, [lifecycle])

  const clearStoppingTask = useCallback((address: RuntimeTaskAddress) => {
    const key = runtimeTaskKey(address)
    stopRequestsRef.current.delete(key)
    setStoppingTaskKey(current => (current === key ? null : current))
  }, [])

  const persistCache = useCallback(() => {
    const snapshot: RuntimeCacheSnapshot = {
      allDevicesSelected: allDevicesSelectedRef.current,
      devices: devicesRef.current,
      models: modelsRef.current,
      selectedDeviceId: selectedDeviceIdRef.current,
      workByDevice: workByDeviceRef.current,
    }
    return cache.write(snapshot)
  }, [cache])

  const publishSelectedDevice = useCallback(
    (deviceId: string | null, cachedWork?: RuntimeWorkListResponse) => {
      allDevicesSelectedRef.current = false
      setAllDevicesSelected(false)
      selectedDeviceIdRef.current = deviceId
      setSelectedDeviceId(deviceId)
      const nextWork = cachedWork ?? (deviceId ? workByDeviceRef.current[deviceId] : undefined)
      workRef.current = nextWork ?? EMPTY_WORK
      setWork(workRef.current)
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
      } else if (selectedDeviceIdRef.current === deviceId) {
        workRef.current = nextWork
        setWork(nextWork)
        if (lifecycle.syncWork(nextWork)) publishTaskLifecycle()
      }
      await persistCache()
    },
    [lifecycle, persistCache, publishTaskLifecycle]
  )

  const reloadWork = useCallback(
    async (requestedDeviceId?: string | null) => {
      const deviceId = requestedDeviceId ?? selectedDeviceIdRef.current
      if (!deviceId) return EMPTY_WORK
      const revision = nextWorkRevision(deviceId)
      const deviceName = devicesRef.current.find(device => device.device_id === deviceId)?.name
      const nextWork = await stream.listWork(deviceId, deviceName)
      if (workRequestRevisionRef.current.get(deviceId) !== revision) return nextWork
      await commitDeviceWork(deviceId, nextWork)
      return nextWork
    },
    [commitDeviceWork, nextWorkRevision, stream]
  )

  const reloadAllWork = useCallback(async () => {
    const onlineDevices = devicesRef.current.filter(device => device.status !== 'offline')
    const requests = onlineDevices.map(device => ({
      device,
      revision: nextWorkRevision(device.device_id),
      request: stream.listWork(device.device_id, device.name),
    }))
    const results = await Promise.allSettled(requests.map(item => item.request))
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failed) throw failed.reason

    const nextWorkByDevice = { ...workByDeviceRef.current }
    results.forEach((result, index) => {
      const request = requests[index]
      if (
        result.status === 'fulfilled' &&
        request &&
        workRequestRevisionRef.current.get(request.device.device_id) === request.revision
      ) {
        nextWorkByDevice[request.device.device_id] = result.value
      }
    })
    workByDeviceRef.current = nextWorkByDevice
    if (allDevicesSelectedRef.current) {
      const merged = mergeRuntimeWorkForDevices(
        nextWorkByDevice,
        devicesRef.current.map(device => device.device_id)
      )
      workRef.current = merged
      setWork(merged)
      if (lifecycle.syncWork(merged)) publishTaskLifecycle()
    }
    await persistCache()
  }, [lifecycle, nextWorkRevision, persistCache, publishTaskLifecycle, stream])

  const workInvalidator = useMemo(
    () =>
      new RuntimeWorkInvalidator(async () => {
        if (allDevicesSelectedRef.current) await reloadAllWork()
        else await reloadWork(selectedDeviceIdRef.current)
      }),
    [reloadAllWork, reloadWork]
  )

  const invalidateWork = useCallback(() => {
    void workInvalidator.invalidate().catch(cause => setError(messageFrom(cause)))
  }, [workInvalidator])

  const reloadTranscript = useCallback(
    async (address: RuntimeTaskAddress, replace = false) => {
      const observation = lifecycle.transcriptRequested(address)
      const transcript = await stream.getTranscript(address)
      if (
        typeof transcript.running === 'boolean' &&
        lifecycle.transcriptReceived(observation, transcript.running)
      ) {
        publishTaskLifecycle()
      }
      if (transcript.running === false) clearStoppingTask(address)
      if (!sameRuntimeAddress(currentAddressRef.current, address)) return
      dispatchMessages({
        type: replace ? 'replace' : 'merge-latest',
        messages: transcript.messages,
      })
      if (replace) {
        transcriptBeforeCursorRef.current = transcript.beforeCursor ?? null
        setHasMoreMessagesBefore(Boolean(transcript.beforeCursor))
      }
      if (transcript.title) setCurrentTitle(transcript.title)
    },
    [clearStoppingTask, lifecycle, publishTaskLifecycle, stream]
  )

  const loadMoreMessagesBefore = useCallback(async () => {
    const address = currentAddressRef.current
    const beforeCursor = transcriptBeforeCursorRef.current
    if (!address || !beforeCursor || loadingMoreMessagesBeforeRef.current) return

    const revision = transcriptPaginationRevisionRef.current
    loadingMoreMessagesBeforeRef.current = true
    setLoadingMoreMessagesBefore(true)
    try {
      const transcript = await stream.getTranscript(address, { beforeCursor })
      if (
        transcriptPaginationRevisionRef.current !== revision ||
        !sameRuntimeAddress(currentAddressRef.current, address)
      )
        return
      dispatchMessages({ type: 'prepend', messages: transcript.messages })
      transcriptBeforeCursorRef.current = transcript.beforeCursor ?? null
      setHasMoreMessagesBefore(Boolean(transcript.beforeCursor))
    } catch (cause) {
      if (
        transcriptPaginationRevisionRef.current === revision &&
        sameRuntimeAddress(currentAddressRef.current, address)
      ) {
        setError(messageFrom(cause))
      }
    } finally {
      if (
        transcriptPaginationRevisionRef.current === revision &&
        sameRuntimeAddress(currentAddressRef.current, address)
      ) {
        loadingMoreMessagesBeforeRef.current = false
        setLoadingMoreMessagesBefore(false)
      }
    }
  }, [stream])

  const subscribe = useCallback(
    (address: RuntimeTaskAddress) => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = stream.subscribe(
        address,
        event => {
          dispatchMessages({
            type: 'stream',
            event,
          })
        },
        () => void reloadTranscript(address).catch(cause => setError(messageFrom(cause)))
      )
    },
    [reloadTranscript, stream]
  )

  const applyModels = useCallback((nextModels: UnifiedModel[]) => {
    modelsRef.current = nextModels
    setModels(nextModels)
    setSelectedModel(current => {
      const next =
        nextModels.find(model => model.name === current?.name && model.type === current.type) ??
        defaultModel(nextModels)
      if (next && (!current || next.name !== current.name || next.type !== current.type)) {
        setSelectedModelOptions(defaultModelOptions(next))
      }
      return next
    })
  }, [])

  const refreshDevices = useCallback(async (): Promise<string | null> => {
    const response = await api.listDevices()
    const operableDevices = mobileOperableDevices(response.items)
    const operableDeviceIds = operableDevices.map(device => device.device_id)
    devicesRef.current = operableDevices
    workByDeviceRef.current = runtimeWorkForDevices(workByDeviceRef.current, operableDeviceIds)
    setDevices(operableDevices)
    if (allDevicesSelectedRef.current) {
      publishAllDevices()
      await persistCache()
      return null
    }
    const deviceId = selectedOnlineDeviceId(operableDevices, selectedDeviceIdRef.current)
    if (deviceId !== selectedDeviceIdRef.current) publishSelectedDevice(deviceId)
    await persistCache()
    return deviceId
  }, [api, persistCache, publishAllDevices, publishSelectedDevice])

  const refresh = useCallback(async () => {
    const deviceId = selectedDeviceIdRef.current
    if ((!allDevicesSelectedRef.current && !deviceId) || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setError(null)
    try {
      if (allDevicesSelectedRef.current) await reloadAllWork()
      else await reloadWork(deviceId)
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [reloadAllWork, reloadWork])

  useEffect(() => {
    setTaskRunningByKey(lifecycle.snapshot())
  }, [lifecycle])

  useEffect(
    () =>
      stream.subscribeLifecycle((address, event) => {
        const taskKnown = runtimeWorkContainsTask(workRef.current, address)
        if (isRunningRuntimeEvent(event.name) && lifecycle.executorStarted(address)) {
          publishTaskLifecycle()
        }
        if (shouldReloadRuntimeWork(event.name, taskKnown)) invalidateWork()
        if (isTerminalRuntimeEvent(event.name)) {
          const current = currentAddressRef.current
          if (current && runtimeTaskKey(current) === runtimeTaskKey(address)) {
            void reloadTranscript(address).catch(cause => setError(messageFrom(cause)))
          }
        }
      }, invalidateWork),
    [invalidateWork, lifecycle, publishTaskLifecycle, reloadTranscript, stream]
  )

  useEffect(() => {
    let previousState = AppState.currentState
    const subscription = AppState.addEventListener('change', nextState => {
      const becameActive = nextState === 'active' && previousState !== 'active'
      previousState = nextState
      if (becameActive) invalidateWork()
    })
    return () => subscription.remove()
  }, [invalidateWork])

  useEffect(() => {
    if (!selectedWorkspace) {
      setGitRef(null)
      return
    }
    let active = true
    void api
      .preflightWorkspace({
        deviceId: selectedWorkspace.deviceId,
        sourcePath: selectedWorkspace.workspacePath,
      })
      .then(result => {
        if (active) setGitRef(result.gitRepository ? (result.gitRef ?? null) : null)
      })
      .catch(() => {
        if (active) setGitRef(null)
      })
    return () => {
      active = false
    }
  }, [api, selectedWorkspace])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cached = await cache.read()
      if (cancelled) return
      const cachedDevices = mobileOperableDevices(cached.devices)
      devicesRef.current = cachedDevices
      modelsRef.current = cached.models
      workByDeviceRef.current = runtimeWorkForDevices(
        cached.workByDevice,
        cachedDevices.map(device => device.device_id)
      )
      setDevices(cachedDevices)
      applyModels(cached.models)
      const cachedDeviceId = selectedOnlineDeviceId(cachedDevices, cached.selectedDeviceId)
      const cachedWork = cached.allDevicesSelected
        ? publishAllDevices()
        : publishSelectedDevice(
            cachedDeviceId,
            cachedDeviceId ? cached.workByDevice[cachedDeviceId] : undefined
          )
      const hasCachedWork = cached.allDevicesSelected
        ? cachedDevices.some(device => Boolean(cached.workByDevice[device.device_id]))
        : Boolean(cachedDeviceId && cached.workByDevice[cachedDeviceId])
      if (cachedWork && lifecycle.syncWork(cachedWork)) publishTaskLifecycle()
      setLoading(!hasCachedWork)

      let deviceId = cachedDeviceId
      try {
        deviceId = await refreshDevices()
      } catch (cause) {
        if (!cancelled) setError(messageFrom(cause))
      }
      if (cancelled) return

      const selectedCachedWork = allDevicesSelectedRef.current
        ? mergeRuntimeWorkForDevices(
            workByDeviceRef.current,
            devicesRef.current.map(device => device.device_id)
          )
        : deviceId
          ? workByDeviceRef.current[deviceId]
          : undefined
      if (selectedCachedWork && (allDevicesSelectedRef.current || deviceId)) {
        workRef.current = selectedCachedWork
        setWork(selectedCachedWork)
        setLoading(false)
      }
      if (allDevicesSelectedRef.current) {
        void reloadAllWork()
          .catch(cause => {
            if (!cancelled) setError(messageFrom(cause))
          })
          .finally(() => {
            if (!cancelled && allDevicesSelectedRef.current) setLoading(false)
          })
      } else if (deviceId) {
        void reloadWork(deviceId)
          .catch(cause => {
            if (!cancelled) setError(messageFrom(cause))
          })
          .finally(() => {
            if (!cancelled && selectedDeviceIdRef.current === deviceId) setLoading(false)
          })
      } else {
        setLoading(false)
      }

      void api
        .listModels()
        .then(response => {
          if (cancelled) return
          applyModels(response.data)
          void persistCache().catch(cause => console.warn('Failed to cache models', cause))
        })
        .catch(cause => {
          if (!cancelled && cached.models.length === 0) setError(messageFrom(cause))
        })
    })()
    return () => {
      cancelled = true
      unsubscribeRef.current?.()
      stream.dispose()
    }
  }, [
    api,
    applyModels,
    cache,
    lifecycle,
    persistCache,
    publishSelectedDevice,
    publishAllDevices,
    publishTaskLifecycle,
    refreshDevices,
    reloadAllWork,
    reloadWork,
    stream,
  ])

  const selectDevice = useCallback(
    (deviceId: string) => {
      if (!allDevicesSelectedRef.current && deviceId === selectedDeviceIdRef.current) return
      const cachedWork = publishSelectedDevice(deviceId)
      setLoading(!cachedWork)
      void reloadWork(deviceId)
        .catch(cause => setError(messageFrom(cause)))
        .finally(() => {
          if (selectedDeviceIdRef.current === deviceId) setLoading(false)
        })
    },
    [publishSelectedDevice, reloadWork]
  )

  const selectAllDevices = useCallback(() => {
    if (allDevicesSelectedRef.current) return
    const hasCachedWork = devicesRef.current.some(device =>
      Boolean(workByDeviceRef.current[device.device_id])
    )
    publishAllDevices()
    setLoading(!hasCachedWork)
    void reloadAllWork()
      .catch(cause => setError(messageFrom(cause)))
      .finally(() => {
        if (allDevicesSelectedRef.current) setLoading(false)
      })
  }, [publishAllDevices, reloadAllWork])

  const openConversation = useCallback(
    async (item: ConversationItem) => {
      setLoading(true)
      setError(null)
      transcriptPaginationRevisionRef.current += 1
      transcriptBeforeCursorRef.current = null
      loadingMoreMessagesBeforeRef.current = false
      setHasMoreMessagesBefore(false)
      setLoadingMoreMessagesBefore(false)
      dispatchMessages({ type: 'replace', messages: [] })
      currentAddressRef.current = item.address
      setCurrentAddress(item.address)
      setCurrentTitle(item.title)
      if (!allDevicesSelectedRef.current) publishSelectedDevice(item.address.deviceId, work)
      const workspace = allWorkspaces(work).find(
        candidate =>
          candidate.deviceId === item.address.deviceId &&
          candidate.workspacePath === item.address.workspacePath
      )
      setSelectedWorkspace(workspace ?? null)
      subscribe(item.address)
      try {
        await reloadTranscript(item.address, true)
      } catch (cause) {
        if (sameRuntimeAddress(currentAddressRef.current, item.address)) {
          setError(messageFrom(cause))
        }
      } finally {
        if (sameRuntimeAddress(currentAddressRef.current, item.address)) setLoading(false)
      }
    },
    [publishSelectedDevice, reloadTranscript, subscribe, work]
  )

  const startNewConversation = useCallback(
    (workspace?: RuntimeDeviceWorkspace) => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      currentAddressRef.current = null
      setCurrentAddress(null)
      setCurrentTitle(workspace?.label || '新会话')
      transcriptPaginationRevisionRef.current += 1
      transcriptBeforeCursorRef.current = null
      loadingMoreMessagesBeforeRef.current = false
      setHasMoreMessagesBefore(false)
      setLoadingMoreMessagesBefore(false)
      if (workspace && !allDevicesSelectedRef.current) {
        publishSelectedDevice(workspace.deviceId, workRef.current)
      }
      setSelectedWorkspace(workspace ?? null)
      dispatchMessages({ type: 'replace', messages: [] })
    },
    [publishSelectedDevice]
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
        createdAt: Date.now(),
      })
      setSending(true)
      setError(null)

      try {
        if (!selectedModel) throw new Error('请选择可用模型')
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
          subscribe(address)
          const response = await api.sendMessage(
            address,
            message,
            userMessageId,
            continuationSelection(model),
            options?.attachmentIds
          )
          if (!response.accepted) throw new Error(response.error || '发送未被执行器接受')
          return true
        }

        const requestedDeviceId =
          selectedWorkspace?.deviceId ??
          selectedDeviceId ??
          selectedOnlineDeviceId(devicesRef.current, null)
        if (!requestedDeviceId) throw new Error('没有可用的云端 executor')
        const deviceId = requestedDeviceId
        const taskId = createRuntimeTaskId()
        const workspacePath = selectedWorkspace
          ? selectedWorkspace.workspacePath
          : await createConversationWorkspace(api, deviceId, message, taskId)
        provisionalAddress = {
          deviceId,
          taskId,
          runtime: 'codex',
          workspacePath,
          workspaceKind: selectedWorkspace?.workspaceKind ?? 'chat',
        }
        currentAddressRef.current = provisionalAddress
        setCurrentAddress(provisionalAddress)
        setCurrentTitle(titleFrom(message))
        sendTransition = lifecycle.sendRequested(provisionalAddress)
        publishTaskLifecycle()
        subscribe(provisionalAddress)

        const response = await api.createConversation({
          schemaVersion: 2,
          deviceId,
          workspacePath,
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
        currentAddressRef.current = resolvedAddress
        setCurrentAddress(resolvedAddress)
        if (response.taskId !== taskId) {
          sendTransition = lifecycle.renameSend(sendTransition, resolvedAddress)
          publishTaskLifecycle()
          subscribe(resolvedAddress)
        }
        void reloadWork(resolvedAddress.deviceId).catch(cause => setError(messageFrom(cause)))
        return true
      } catch (cause) {
        if (sendTransition && lifecycle.sendRejected(sendTransition)) publishTaskLifecycle()
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
      lifecycle,
      publishTaskLifecycle,
      reloadWork,
      selectedDeviceId,
      selectedModel,
      selectedModelOptions,
      permissionMode,
      selectedWorkspace,
      sending,
      subscribe,
      currentTaskRunning,
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
      void reloadWork(address.deviceId).catch(cause => setError(messageFrom(cause)))
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
        return await api.uploadAttachment(asset)
      } catch (cause) {
        setError(messageFrom(cause))
        throw cause
      }
    },
    [api]
  )

  const loadComposerApps = useCallback(async () => {
    const deviceId =
      currentAddressRef.current?.deviceId ??
      selectedWorkspace?.deviceId ??
      selectedDeviceId ??
      selectedOnlineDeviceId(devicesRef.current, null)
    if (!deviceId) throw new Error('请先选择在线 Executor')
    const installedPlugins = await api.listInstalledPlugins(deviceId)
    return composerApps(installedPlugins)
  }, [api, selectedDeviceId, selectedWorkspace?.deviceId])

  const createProject = useCallback(
    async (input: { deviceId: string; workspacePath: string; name: string }) => {
      setLoading(true)
      setError(null)
      try {
        const result = await api.openWorkspace({
          deviceId: input.deviceId,
          workspacePath: input.workspacePath.trim(),
        })
        if (!result.accepted) throw new Error(result.error || '项目创建失败')
        if (input.name.trim()) {
          await api.renameWorkspace({
            deviceId: input.deviceId,
            workspacePath: result.workspacePath,
            name: input.name.trim(),
          })
        }
        publishSelectedDevice(input.deviceId)
        const refreshedWork = await reloadWork(input.deviceId)
        const workspace = allWorkspaces(refreshedWork).find(
          candidate =>
            candidate.deviceId === input.deviceId &&
            candidate.workspacePath === result.workspacePath
        )
        if (workspace) startNewConversation(workspace)
      } catch (cause) {
        const messageText = messageFrom(cause)
        setError(messageText)
        throw cause
      } finally {
        setLoading(false)
      }
    },
    [api, publishSelectedDevice, reloadWork, startNewConversation]
  )

  return {
    work,
    devices,
    conversations: flattenConversations(work, taskRunningByKey),
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
    hasMoreMessagesBefore,
    loadingMoreMessagesBefore,
    refreshing,
    sending,
    running: currentTaskRunning,
    stopping: currentTaskStopping,
    error,
    refresh,
    loadMoreMessagesBefore,
    openConversation,
    startNewConversation,
    selectDevice,
    selectAllDevices,
    selectWorkspace: setSelectedWorkspace,
    selectModel: (model, options) => {
      setSelectedModel(model)
      setSelectedModelOptions(options ?? defaultModelOptions(model))
    },
    selectPermissionMode,
    send,
    stop,
    uploadAttachment,
    loadComposerApps,
    createProject,
    clearError: () => setError(null),
  }
}

function runtimeTaskRunning(
  address: RuntimeTaskAddress,
  work: RuntimeWorkListResponse,
  runningByTask: ReadonlyMap<string, boolean>
): boolean {
  const projected = runningByTask.get(runtimeTaskKey(address))
  if (typeof projected === 'boolean') return projected
  return allWorkspaces(work).some(
    workspace =>
      workspace.deviceId === address.deviceId &&
      workspace.tasks.some(task => task.taskId === address.taskId && task.running === true)
  )
}

function sameRuntimeAddress(
  current: RuntimeTaskAddress | null,
  candidate: RuntimeTaskAddress
): boolean {
  return current?.deviceId === candidate.deviceId && current.taskId === candidate.taskId
}

function createRuntimeTaskId(): string {
  const seed = `codex-${Crypto.randomUUID()}`
  let hash = 0
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return `runtime-${(hash % 1_000_000_000) + 1}`
}

function titleFrom(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return Array.from(normalized).slice(0, 48).join('') || '新会话'
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
