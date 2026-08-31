import * as Crypto from 'expo-crypto'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AppState } from 'react-native'

import { chatReducer } from '@/domain/chatReducer'
import { composerApps } from '@/domain/composerApps'
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
import { allWorkspaces, flattenConversations, runtimeWorkContainsTask } from '@/domain/work'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import { RuntimeApi } from '@/services/runtimeApi'
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
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  permissionMode: RuntimePermissionMode
  gitRef: string | null
  loading: boolean
  sending: boolean
  running: boolean
  stopping: boolean
  error: string | null
  refresh: () => Promise<void>
  openConversation: (item: ConversationItem) => Promise<void>
  startNewConversation: (workspace?: RuntimeDeviceWorkspace) => void
  selectDevice: (deviceId: string) => void
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

export function useMobileRuntime(config: RuntimeSessionConfig): MobileRuntimeState {
  const api = useMemo(() => new RuntimeApi(config), [config])
  const stream = useMemo(() => new RuntimeStream(config), [config])
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
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModel, setSelectedModel] = useState<UnifiedModel | null>(null)
  const [selectedModelOptions, setSelectedModelOptions] = useState<ModelOptions>({})
  const [permissionMode, setPermissionMode] = useState<RuntimePermissionMode>(
    DEFAULT_RUNTIME_PERMISSION_MODE
  )
  const [gitRef, setGitRef] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [stoppingTaskKey, setStoppingTaskKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const currentAddressRef = useRef<RuntimeTaskAddress | null>(null)
  const workRequestIdRef = useRef(0)
  const stopRequestsRef = useRef(new Set<string>())

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

  const reloadWork = useCallback(async () => {
    const requestId = ++workRequestIdRef.current
    const nextWork = await api.listWork()
    if (requestId !== workRequestIdRef.current) return nextWork
    workRef.current = nextWork
    setWork(nextWork)
    if (lifecycle.syncWork(nextWork)) publishTaskLifecycle()
    return nextWork
  }, [api, lifecycle, publishTaskLifecycle])

  const workInvalidator = useMemo(
    () =>
      new RuntimeWorkInvalidator(async () => {
        await reloadWork()
      }),
    [reloadWork]
  )

  const invalidateWork = useCallback(() => {
    void workInvalidator.invalidate().catch(cause => setError(messageFrom(cause)))
  }, [workInvalidator])

  const reloadTranscript = useCallback(
    async (address: RuntimeTaskAddress) => {
      const observation = lifecycle.transcriptRequested(address)
      const transcript = await stream.getTranscript(address)
      if (
        typeof transcript.running === 'boolean' &&
        lifecycle.transcriptReceived(observation, transcript.running)
      ) {
        publishTaskLifecycle()
      }
      if (transcript.running === false) clearStoppingTask(address)
      if (currentAddressRef.current?.taskId !== address.taskId) return
      dispatchMessages({ type: 'replace', messages: transcript.messages })
      if (transcript.title) setCurrentTitle(transcript.title)
    },
    [clearStoppingTask, lifecycle, publishTaskLifecycle, stream]
  )

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

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [, deviceResponse, modelResponse] = await Promise.all([
        reloadWork(),
        api.listDevices(),
        api.listModels(),
      ])
      setDevices(deviceResponse.items)
      setModels(modelResponse.data)
      setSelectedModel(current => {
        const next =
          modelResponse.data.find(
            model => model.name === current?.name && model.type === current.type
          ) ?? defaultModel(modelResponse.data)
        if (next && (!current || next.name !== current.name || next.type !== current.type)) {
          setSelectedModelOptions(defaultModelOptions(next))
        }
        return next
      })
      const online = deviceResponse.items.find(device => device.status !== 'offline')
      setSelectedDeviceId(current => {
        const currentIsOnline = deviceResponse.items.some(
          device => device.device_id === current && device.status !== 'offline'
        )
        return currentIsOnline ? current : (online?.device_id ?? null)
      })
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setLoading(false)
    }
  }, [api, reloadWork])

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
    void refresh()
    return () => {
      unsubscribeRef.current?.()
      stream.dispose()
    }
  }, [refresh, stream])

  const openConversation = useCallback(
    async (item: ConversationItem) => {
      setLoading(true)
      setError(null)
      currentAddressRef.current = item.address
      setCurrentAddress(item.address)
      setCurrentTitle(item.title)
      setSelectedDeviceId(item.address.deviceId)
      const workspace = allWorkspaces(work).find(
        candidate =>
          candidate.deviceId === item.address.deviceId &&
          candidate.workspacePath === item.address.workspacePath
      )
      setSelectedWorkspace(workspace ?? null)
      subscribe(item.address)
      try {
        await reloadTranscript(item.address)
      } catch (cause) {
        setError(messageFrom(cause))
      } finally {
        setLoading(false)
      }
    },
    [reloadTranscript, subscribe, work]
  )

  const startNewConversation = useCallback((workspace?: RuntimeDeviceWorkspace) => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    currentAddressRef.current = null
    setCurrentAddress(null)
    setCurrentTitle(workspace?.label || '新会话')
    setSelectedWorkspace(workspace ?? null)
    if (workspace) setSelectedDeviceId(workspace.deviceId)
    dispatchMessages({ type: 'replace', messages: [] })
  }, [])

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

        const requestedDeviceId = selectedWorkspace?.deviceId ?? selectedDeviceId
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
        void reloadWork().catch(cause => setError(messageFrom(cause)))
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
      void reloadWork().catch(cause => setError(messageFrom(cause)))
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
      currentAddressRef.current?.deviceId ?? selectedWorkspace?.deviceId ?? selectedDeviceId
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
        const refreshedWork = await reloadWork()
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
    [api, reloadWork, startNewConversation]
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
    models,
    selectedModel,
    selectedModelOptions,
    permissionMode,
    gitRef,
    loading,
    sending,
    running: currentTaskRunning,
    stopping: currentTaskStopping,
    error,
    refresh,
    openConversation,
    startNewConversation,
    selectDevice: setSelectedDeviceId,
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
