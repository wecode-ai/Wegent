import { useEffect, useRef } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { getAppPreferences, updateAppPreferences } from '@/desktop/appPreferences'
import {
  findRuntimeTask,
  findRuntimeTaskWorkspace,
} from '@/features/workbench/workbenchRuntimeHelpers'
import { resolveStoredWorkspacePaths } from '@/lib/workspace-path-transfer'
import { applyWorkspacePathTransfer } from '@/components/chat/composer/composerPathTransfer'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

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
    const context = { conversationTitle: currentTask?.title ?? null }
    void invokeDesktopHost('systemDrag.setContext', context)
  }, [currentTask?.title])

  const apply = async (payload: SystemDropPayload, input = latest.current.projectChat.input) => {
    const current = latest.current
    let nextInput = input
    if (payload.text?.trim()) {
      const text = payload.text.trim()
      nextInput = input ? `${input}\n${text}` : text
      current.projectChat.setInput(nextInput)
    }
    const workspace = findRuntimeTaskWorkspace(
      current.state.runtimeWork,
      current.state.currentRuntimeTask
    )
    const transfer = await resolveStoredWorkspacePaths(
      payload.paths,
      workspace?.workspaceSource === 'remote' || Boolean(workspace?.remoteHostId)
    )
    await applyWorkspacePathTransfer(
      nextInput,
      transfer,
      current.projectChat.setInput,
      current.projectChat.handleFileSelect
    )
  }

  useEffect(() => {
    let cancelled = false
    const handlePayload = (payload: SystemDropPayload) => {
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
    const takePending = () =>
      invokeDesktopHost<SystemDropPayload[]>('systemDrag.takePending').then(payloads => {
        if (!cancelled) payloads.forEach(handlePayload)
      })
    void takePending()
    const poll = window.setInterval(() => void takePending(), 250)
    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [])

  return null
}
