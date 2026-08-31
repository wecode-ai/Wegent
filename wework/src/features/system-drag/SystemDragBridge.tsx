import { useEffect, useRef, useState } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  getAppPreferences,
  updateAppPreferences,
  type AppPreferences,
} from '@/desktop/appPreferences'
import {
  findRuntimeTask,
  findRuntimeTaskWorkspace,
} from '@/features/workbench/workbenchRuntimeHelpers'
import {
  hasWorkspacePathDragData,
  resolveStoredWorkspacePaths,
} from '@/lib/workspace-path-transfer'
import { applyWorkspacePathTransfer } from '@/components/chat/composer/composerPathTransfer'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  prepareSelectedTextDrag,
  SELECTED_TEXT_CHANGED_EVENT,
  type SelectedTextChangedDetail,
  type SelectedTextRect,
  writeSelectedTextDragData,
} from '@/lib/selected-text-drag'
import { SelectionActionsPopover } from '@/components/chat/SelectionActionsPopover'

interface SystemDropPayload {
  action: 'new-chat' | 'follow-up' | 'stash'
  text: string | null
  paths: string[]
}

interface ManagedTextSelection {
  source: string
  text: string
  rect: SelectedTextRect
}

const SELECTION_ACTION_GAP = 8
const WORKSPACE_SELECTION_ROOT_SELECTOR = [
  '[data-testid="workspace-file-preview"]',
  '[data-testid="workspace-markdown-preview"]',
  '[data-testid="workspace-file-editor"]',
  '[data-testid="embedded-local-terminal"]',
  '[data-testid="remote-terminal"]',
].join(',')

function selectionElement(node: Node | null): Element | null {
  if (node instanceof Element) return node
  return node?.parentElement ?? null
}

function closestComposed(element: Element | null, selector: string): Element | null {
  let current = element
  while (current) {
    if (current.matches(selector)) return current
    if (current.parentElement) {
      current = current.parentElement
      continue
    }
    const root = current.getRootNode()
    current = root instanceof ShadowRoot ? root.host : null
  }
  return null
}

function selectionInsideWorkspace(selection: Selection): boolean {
  const anchor = selectionElement(selection.anchorNode)
  const focus = selectionElement(selection.focusNode)
  return Boolean(
    closestComposed(anchor, WORKSPACE_SELECTION_ROOT_SELECTOR) &&
    closestComposed(focus, WORKSPACE_SELECTION_ROOT_SELECTOR)
  )
}

function usableSelectionRect(selection: Selection): SelectedTextRect | null {
  const rangeRect = selection.getRangeAt(0).getBoundingClientRect()
  if (rangeRect.width > 0 && rangeRect.height > 0) {
    return {
      left: rangeRect.left,
      top: rangeRect.top,
      width: rangeRect.width,
      height: rangeRect.height,
    }
  }

  const endpointRects = [selection.anchorNode, selection.focusNode]
    .map(selectionElement)
    .filter((element): element is Element => element !== null)
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)
  if (endpointRects.length === 0) return null

  const left = Math.min(...endpointRects.map(rect => rect.left))
  const top = Math.min(...endpointRects.map(rect => rect.top))
  const right = Math.max(...endpointRects.map(rect => rect.right))
  const bottom = Math.max(...endpointRects.map(rect => rect.bottom))
  return { left, top, width: right - left, height: bottom - top }
}

async function dismissSystemDragPanel(): Promise<void> {
  try {
    await invokeDesktopHost('systemDrag.dismissPanel')
  } catch (error) {
    console.error('[Wework] Failed to dismiss system drag panel:', error)
  }
}

export function SystemDragBridge() {
  const workbench = useWorkbench()
  const latest = useRef(workbench)
  const systemDragEnabled = useRef(false)
  const activePanelRequest = useRef<Promise<unknown> | null>(null)
  const [managedSelection, setManagedSelection] = useState<ManagedTextSelection | null>(null)
  const managedSelectionRef = useRef(managedSelection)
  const currentTask = findRuntimeTask(
    workbench.state.runtimeWork,
    workbench.state.currentRuntimeTask
  )

  useEffect(() => {
    latest.current = workbench
  }, [workbench])

  useEffect(() => {
    managedSelectionRef.current = managedSelection
  }, [managedSelection])

  useEffect(() => {
    const context = { conversationTitle: currentTask?.title ?? null }
    void invokeDesktopHost('systemDrag.setContext', context)
  }, [currentTask?.title])

  useEffect(() => {
    let cancelled = false
    void getAppPreferences().then(preferences => {
      if (!cancelled) systemDragEnabled.current = preferences.systemDragEnabled
    })
    const handlePreferencesChanged = (event: Event) => {
      systemDragEnabled.current = (event as CustomEvent<AppPreferences>).detail.systemDragEnabled
      if (!systemDragEnabled.current) {
        activePanelRequest.current = null
        void dismissSystemDragPanel()
      }
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    return () => {
      cancelled = true
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }, [])

  useEffect(() => {
    const updateDocumentSelection = (preserveCapturedSelection = false) => {
      const selection = document.getSelection()
      if (
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        !selectionInsideWorkspace(selection)
      ) {
        if (!preserveCapturedSelection) {
          setManagedSelection(current =>
            current?.source === 'workspace-document' ? null : current
          )
        }
        return
      }
      const text = selection.toString().trim()
      const rect = usableSelectionRect(selection)
      if (!text || !rect) {
        if (!preserveCapturedSelection) {
          setManagedSelection(current =>
            current?.source === 'workspace-document' ? null : current
          )
        }
        return
      }
      setManagedSelection({
        source: 'workspace-document',
        text,
        rect,
      })
    }
    const scheduleUpdate = () => requestAnimationFrame(() => updateDocumentSelection(true))
    const finalizeUpdate = () => updateDocumentSelection()
    document.addEventListener('selectionchange', scheduleUpdate)
    document.addEventListener('pointerup', finalizeUpdate)
    document.addEventListener('keyup', finalizeUpdate)
    return () => {
      document.removeEventListener('selectionchange', scheduleUpdate)
      document.removeEventListener('pointerup', finalizeUpdate)
      document.removeEventListener('keyup', finalizeUpdate)
    }
  }, [])

  useEffect(() => {
    const showPanel = () => {
      const request = invokeDesktopHost('systemDrag.showPanel').catch(error => {
        console.error('[Wework] Failed to show system drag panel:', error)
      })
      activePanelRequest.current = request
    }
    const dismissPanelAfter = (request: Promise<unknown>) => {
      void request.finally(dismissSystemDragPanel).catch(error => {
        console.error('[Wework] Failed to finish system drag panel request:', error)
      })
    }
    const handleSelectedTextChanged = (event: Event) => {
      const { source, text, rect } = (event as CustomEvent<SelectedTextChangedDetail>).detail
      setManagedSelection(current => {
        if (text && rect) return { source, text, rect }
        if (text) return current?.source === source ? current : null
        return current?.source === source ? null : current
      })
    }
    const handleDragStart = (event: DragEvent) => {
      if (!systemDragEnabled.current || !event.dataTransfer) return
      let selectedText = prepareSelectedTextDrag(event)?.trim() ?? ''
      const source = selectionElement(event.target as Node | null)
      if (
        !selectedText &&
        managedSelectionRef.current &&
        closestComposed(source, WORKSPACE_SELECTION_ROOT_SELECTOR)
      ) {
        selectedText = managedSelectionRef.current.text
        writeSelectedTextDragData(event.dataTransfer, selectedText)
      }
      const hasSelectedText = Boolean(selectedText)
      if (!hasSelectedText && !hasWorkspacePathDragData(event.dataTransfer)) return
      setManagedSelection(null)
      showPanel()
    }
    const handleDragEnd = () => {
      const request = activePanelRequest.current
      if (!request) {
        void dismissSystemDragPanel()
        return
      }
      activePanelRequest.current = null
      dismissPanelAfter(request)
    }
    window.addEventListener(SELECTED_TEXT_CHANGED_EVENT, handleSelectedTextChanged)
    document.addEventListener('dragstart', handleDragStart)
    document.addEventListener('dragend', handleDragEnd)
    return () => {
      window.removeEventListener(SELECTED_TEXT_CHANGED_EVENT, handleSelectedTextChanged)
      document.removeEventListener('dragstart', handleDragStart)
      document.removeEventListener('dragend', handleDragEnd)
      const request = activePanelRequest.current
      if (request) {
        activePanelRequest.current = null
        dismissPanelAfter(request)
      }
    }
  }, [])

  const addSelectionToConversation = () => {
    if (!managedSelection) return
    const current = latest.current
    const nextInput = current.projectChat.input
      ? `${current.projectChat.input}\n${managedSelection.text}`
      : managedSelection.text
    current.projectChat.setInput(nextInput)
    setManagedSelection(null)
    document.getSelection()?.removeAllRanges()
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="desktop-floating-composer-card"] [data-testid="chat-message-input"]'
        )
        ?.focus()
    })
  }

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

  return managedSelection ? (
    <SelectionActionsPopover
      position={{
        left: Math.min(
          Math.max(managedSelection.rect.left + managedSelection.rect.width / 2, 120),
          window.innerWidth - 120
        ),
        top: Math.max(managedSelection.rect.top - SELECTION_ACTION_GAP, 44),
      }}
      onAddToConversation={addSelectionToConversation}
      testId="workspace-selection-actions"
      addButtonTestId="add-workspace-selection-to-conversation-button"
    />
  ) : null
}
