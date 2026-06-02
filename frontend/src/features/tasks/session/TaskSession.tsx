// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react'
import type { Task } from '@/types/api'
import { TaskStateMachine } from '../state'
import type {
  SyncOptions,
  TaskRecoveryReason,
  TaskStateData,
  TaskStateMachineDeps,
  UnifiedMessage,
} from '../state'
import { useConsistencyWatcher } from './consistencyWatcher'
import { MessageSyncer, useMessageSyncer } from './messageSyncer'
import { TaskPuller, useTaskPuller } from './taskPuller'

type MessageSession = Omit<
  MessageSyncer,
  'joinRoom' | 'leaveRoom' | 'isSocketConnected' | 'stopStream' | 'resetSession'
>

export type TaskSession = Omit<
  TaskPuller,
  'writeSelectedTask' | 'resetSelectedTaskState' | 'prepareSelectedTaskState'
> &
  MessageSession & {
    taskState: TaskStateData | null
    messages: Map<string, UnifiedMessage>
    isStreaming: boolean
    streamingSubtaskIds: number[]
    runtime: TaskStateData['runtime'] | null
    derived: TaskStateData['derived'] | null
    selectTask: (task: Task | null) => void
    stopStream: (
      taskId?: number,
      backupSubtasks?: Parameters<MessageSyncer['stopStream']>[1],
      team?: Parameters<MessageSyncer['stopStream']>[2]
    ) => Promise<void>
    recoverCurrentTask: (reason?: TaskRecoveryReason) => Promise<void>
    setMessageSyncOptions: (options?: SyncOptions) => void
  }

const TaskSessionContext = createContext<TaskSession | null>(null)

export { TaskSessionContext }

export function TaskSessionProvider({ children }: { children: ReactNode }) {
  const taskPuller = useTaskPuller()
  const {
    pullTaskDetail,
    pullRuntime,
    writeSelectedTask,
    resetSelectedTaskState,
    prepareSelectedTaskState,
    refreshTasks,
    selectedTask,
    selectedTaskDetail,
  } = taskPuller
  const machineRef = useRef<TaskStateMachine | null>(null)
  const unsubscribeMachineRef = useRef<(() => void) | null>(null)
  const messageTransportRef = useRef<{
    joinRoom?: MessageSyncer['joinRoom']
    leaveRoom?: MessageSyncer['leaveRoom']
    isSocketConnected?: MessageSyncer['isSocketConnected']
  }>({})
  const resetMessageSessionRef = useRef<(() => void) | null>(null)
  const [taskState, setTaskState] = useState<TaskStateData | null>(null)

  const disposeMachine = useCallback(() => {
    unsubscribeMachineRef.current?.()
    unsubscribeMachineRef.current = null
    machineRef.current?.closeTask()
    resetMessageSessionRef.current?.()
    machineRef.current = null
    setTaskState(null)
  }, [])

  const createMachineDeps = useCallback(
    (): TaskStateMachineDeps => ({
      pullTaskDetail,
      pullRuntime,
      joinTask: (taskId, options) => {
        const joinRoom = messageTransportRef.current.joinRoom
        if (!joinRoom) {
          return Promise.resolve({ error: 'Message transport is not ready' })
        }
        return joinRoom(taskId, options)
      },
      leaveTask: taskId => {
        messageTransportRef.current.leaveRoom?.(taskId)
      },
      isConnected: () => messageTransportRef.current.isSocketConnected?.() ?? false,
    }),
    [pullRuntime, pullTaskDetail]
  )

  const getMachine = useCallback(() => machineRef.current, [])

  const ensureMachine = useCallback(
    (taskId: number): TaskStateMachine => {
      const existing = machineRef.current
      if (existing?.getState().taskId === taskId) {
        existing.updateDeps(createMachineDeps())
        return existing
      }

      disposeMachine()

      const machine = new TaskStateMachine(taskId, createMachineDeps())
      machineRef.current = machine
      setTaskState(machine.getState())
      unsubscribeMachineRef.current = machine.subscribe(setTaskState)
      return machine
    },
    [createMachineDeps, disposeMachine]
  )

  const handleTaskIdResolved = useCallback(
    (realTaskId: number, previousTaskId: number) => {
      if (realTaskId === previousTaskId) return
      writeSelectedTask({ id: realTaskId } as Task)
      setTaskState(machineRef.current?.getState() ?? null)
    },
    [writeSelectedTask]
  )

  const messageSyncer = useMessageSyncer({
    getMachine,
    ensureMachine,
    onTaskIdResolved: handleTaskIdResolved,
  })

  messageTransportRef.current = {
    joinRoom: messageSyncer.joinRoom,
    leaveRoom: messageSyncer.leaveRoom,
    isSocketConnected: messageSyncer.isSocketConnected,
  }
  resetMessageSessionRef.current = messageSyncer.resetSession

  useEffect(() => {
    machineRef.current?.updateDeps(createMachineDeps())
  }, [createMachineDeps])

  useEffect(() => {
    const detail = selectedTaskDetail
    const machine = machineRef.current
    if (!detail || !machine || machine.getState().taskId !== detail.id) return
    machine.syncTaskDetail(detail)
  }, [selectedTaskDetail?.id, selectedTaskDetail?.status, selectedTaskDetail?.updated_at])

  const selectTask = useCallback(
    (task: Task | null) => {
      const currentTaskId = machineRef.current?.getState().taskId

      if (!task) {
        disposeMachine()
        resetSelectedTaskState()
        return
      }

      const nextTaskId = task.id

      if (currentTaskId !== undefined && currentTaskId === nextTaskId) {
        return
      }

      if (currentTaskId !== undefined && currentTaskId !== nextTaskId) {
        disposeMachine()
      }

      prepareSelectedTaskState(task)

      const machine = ensureMachine(nextTaskId)
      void machine.openTask()
    },
    [disposeMachine, ensureMachine, prepareSelectedTaskState, resetSelectedTaskState]
  )

  useConsistencyWatcher({
    taskId: selectedTask?.id ?? null,
    getMachine,
    refreshTasks,
  })

  const setMessageSyncOptions = useCallback((options?: SyncOptions) => {
    if (options) {
      machineRef.current?.setSyncOptions(options)
    }
  }, [])

  const recoverCurrentTask = useCallback(async (reason: TaskRecoveryReason = 'manual-refresh') => {
    await machineRef.current?.checkHealth(reason)
  }, [])

  const stopStream = useCallback(
    async (
      taskId?: number,
      backupSubtasks?: Parameters<MessageSyncer['stopStream']>[1],
      team?: Parameters<MessageSyncer['stopStream']>[2]
    ) => {
      const currentTaskId = machineRef.current?.getState().taskId
      const requestedTaskId = taskId ?? currentTaskId
      if (!currentTaskId || requestedTaskId !== currentTaskId) return
      await messageSyncer.stopStream(requestedTaskId, backupSubtasks, team)
    },
    [messageSyncer]
  )

  const streamingSubtaskIds = useMemo(() => {
    if (!taskState) return []

    const subtaskIds = new Set<number>()
    if (taskState.streamingSubtaskId !== null) {
      subtaskIds.add(taskState.streamingSubtaskId)
    }

    taskState.messages.forEach(message => {
      if (message.type === 'ai' && message.status === 'streaming' && message.subtaskId) {
        subtaskIds.add(message.subtaskId)
      }
    })

    return Array.from(subtaskIds)
  }, [taskState])

  const value = useMemo<TaskSession>(() => {
    const {
      writeSelectedTask: _writeSelectedTask,
      resetSelectedTaskState: _resetSelectedTaskState,
      prepareSelectedTaskState: _prepareSelectedTaskState,
      ...publicTaskPuller
    } = taskPuller

    return {
      ...publicTaskPuller,
      selectTask,
      sendMessage: messageSyncer.sendMessage,
      stopStream,
      cleanupMessagesAfterEdit: messageSyncer.cleanupMessagesAfterEdit,
      taskState,
      messages: taskState?.messages ?? new Map<string, UnifiedMessage>(),
      isStreaming: taskState?.status === 'streaming' || streamingSubtaskIds.length > 0,
      streamingSubtaskIds,
      runtime: taskState?.runtime ?? null,
      derived: taskState?.derived ?? null,
      recoverCurrentTask,
      setMessageSyncOptions,
    }
  }, [
    messageSyncer,
    recoverCurrentTask,
    selectTask,
    setMessageSyncOptions,
    stopStream,
    streamingSubtaskIds,
    taskPuller,
    taskState,
  ])

  return <TaskSessionContext.Provider value={value}>{children}</TaskSessionContext.Provider>
}

export function useTaskSession(): TaskSession {
  const context = useContext(TaskSessionContext)
  if (!context) {
    throw new Error('useTaskSession must be used within a TaskSessionProvider')
  }
  return context
}

export function useOptionalTaskSession(): TaskSession | null {
  return useContext(TaskSessionContext)
}
