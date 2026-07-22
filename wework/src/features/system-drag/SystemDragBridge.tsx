import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { getAppPreferences, updateAppPreferences } from '@/tauri/appPreferences'
import { readDroppedFiles } from '@/tauri/droppedFiles'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'

interface SystemDropPayload {
  action: 'new-chat' | 'follow-up' | 'stash'
  text: string | null
  paths: string[]
}

export function SystemDragBridge() {
  const workbench = useWorkbench()
  const latest = useRef(workbench)
  const currentTask = findRuntimeTask(
    workbench.state.runtimeWork,
    workbench.state.currentRuntimeTask
  )

  useEffect(() => {
    latest.current = workbench
  }, [workbench])

  useEffect(() => {
    void emitTo('system-drag-panel', 'wework-system-drag-context', {
      conversationTitle: currentTask?.title ?? null,
    }).catch(() => undefined)
  }, [currentTask?.title])

  useEffect(() => {
    let cancelled = false
    let dispose: (() => void) | undefined
    void listen('wework-system-drag-context-requested', () => {
      const task = findRuntimeTask(
        latest.current.state.runtimeWork,
        latest.current.state.currentRuntimeTask
      )
      void emitTo('system-drag-panel', 'wework-system-drag-context', {
        conversationTitle: task?.title ?? null,
      })
    }).then(unlisten => {
      if (cancelled) unlisten()
      else dispose = unlisten
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  const apply = async (payload: SystemDropPayload, input = latest.current.projectChat.input) => {
    const current = latest.current
    if (payload.text?.trim()) {
      const text = payload.text.trim()
      current.projectChat.setInput(input ? `${input}\n${text}` : text)
    }
    const files = await readDroppedFiles(payload.paths)
    void invoke('log_system_drag_debug', {
      stage: 'main_files_loaded',
      action: payload.action,
      rawPathCount: payload.paths.length,
      uniquePathCount: files.length,
    })
    if (files.length > 0) await current.projectChat.handleFileSelect(files)
  }

  useEffect(() => {
    let cancelled = false
    let dispose: (() => void) | undefined
    const handlePayload = (payload: SystemDropPayload) => {
      void invoke('log_system_drag_debug', {
        stage: 'main_bridge_received',
        action: payload.action,
        rawPathCount: payload.paths.length,
        uniquePathCount: new Set(payload.paths).size,
      })
      if (payload.action === 'stash') {
        void getAppPreferences().then(preferences => {
          const createdAt = Date.now()
          const title =
            payload.text?.trim().split('\n')[0].slice(0, 40) ||
            payload.paths[0]?.split('/').pop() ||
            '暂存内容'
          return updateAppPreferences({
            quickPhrases: [
              {
                id: `stash-${createdAt}`,
                title,
                content: payload.text?.trim() ?? '',
                mode: 'normal',
                attachmentPaths: payload.paths,
                createdAt,
              },
              ...preferences.quickPhrases,
            ],
          })
        })
        return
      }
      if (payload.action === 'follow-up' && !latest.current.state.currentRuntimeTask) return
      if (payload.action === 'new-chat') {
        const wasInConversation = Boolean(latest.current.state.currentRuntimeTask)
        latest.current.startNewChat()
        if (wasInConversation) {
          window.setTimeout(() => void apply(payload, ''), 0)
          return
        }
      }
      void apply(payload)
    }
    void invoke<SystemDropPayload[]>('take_pending_system_drag_drops').then(payloads => {
      if (!cancelled) payloads.forEach(handlePayload)
    })
    void listen<SystemDropPayload>('wework-system-drag-drop', event => {
      if (!cancelled) handlePayload(event.payload)
    }).then(unlisten => {
      if (cancelled) unlisten()
      else dispose = unlisten
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  return null
}
