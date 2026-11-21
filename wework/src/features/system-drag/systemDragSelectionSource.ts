import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import {
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
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import {
  prepareSelectedTextDrag,
  type SelectedTextChangedDetail,
  type SelectedTextRect,
  writeSelectedTextDragData,
} from '@/lib/selected-text-drag'

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

async function dismissSystemDragPanel(presentationId?: number): Promise<void> {
  try {
    const currentId =
      presentationId ??
      (await invokeDesktopHost<{ presentationId: number | null }>('systemDrag.getContext'))
        .presentationId
    if (currentId === null) return
    await invokeDesktopHost('systemDrag.dismissPanel', { presentationId: currentId })
  } catch (error) {
    console.error('[Wework] Failed to dismiss system drag panel:', error)
  }
}

function targetKey(context: WorkbenchContextValue): string {
  const address = context.state.currentRuntimeTask
  return JSON.stringify(
    address
      ? [address.deviceId, address.taskId]
      : [
          context.state.currentProject?.id,
          context.state.standaloneDeviceId,
          context.state.standaloneWorkspacePath,
        ]
  )
}

/** Owns the selected text shown by the workbench and its native drag/drop transactions. */
export function createSystemDragSelectionSource() {
  const listeners = new Set<() => void>()
  const frames = new Set<number>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let context: WorkbenchContextValue | null = null
  let selection: ManagedTextSelection | null = null
  let enabled = false
  let preferencesRevision = 0
  let activePanel: Promise<number | undefined> | null = null
  let stop: (() => void) | null = null
  let generation = 0
  let title: string | null | undefined
  const observed = () => listeners.size > 0 && context !== null
  const setSelection = (
    value:
      | ManagedTextSelection
      | null
      | ((previous: ManagedTextSelection | null) => ManagedTextSelection | null)
  ) => {
    const next = typeof value === 'function' ? value(selection) : value
    if (selection === next) return
    selection = next
    listeners.forEach(listener => listener())
  }
  const scheduleFrame = (action: () => void) => {
    const frame = requestAnimationFrame(() => {
      frames.delete(frame)
      if (observed()) action()
    })
    frames.add(frame)
  }
  const dismissPanelAfter = (request: Promise<number | undefined>) => {
    void request
      .then(presentationId => {
        if (presentationId !== undefined) return dismissSystemDragPanel(presentationId)
      })
      .catch(error => console.error('[Wework] Failed to finish system drag panel request:', error))
  }
  const reportTransferError = (error: unknown) => {
    if (observed())
      context!.setWorkbenchError(error instanceof Error ? error.message : String(error))
  }
  const apply = async (payload: SystemDropPayload, input = context?.projectChat.input ?? '') => {
    if (!observed()) return
    const current = context!
    const owner = generation
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
    if (!observed() || generation !== owner) return
    await applyWorkspacePathTransfer(
      nextInput,
      transfer,
      current.projectChat.setInput,
      current.projectChat.handleFileSelect
    )
  }
  const handlePayload = (payload: SystemDropPayload) => {
    if (!observed()) return
    if (payload.action === 'stash') {
      void getAppPreferences()
        .then(preferences => {
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
        .catch(reportTransferError)
      return
    }
    if (payload.action === 'follow-up' && !context!.state.currentRuntimeTask) return
    if (payload.action === 'new-chat') {
      const wasInConversation = Boolean(context!.state.currentRuntimeTask)
      context!.startNewChat()
      if (wasInConversation) {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (observed()) void apply(payload, '').catch(reportTransferError)
        }, 0)
        timers.add(timer)
        return
      }
    }
    void apply(payload).catch(reportTransferError)
  }
  const preferencesChanged = (event: Event) => {
    if (!observed()) return
    preferencesRevision++
    enabled = (event as CustomEvent<AppPreferences>).detail.systemDragEnabled
    if (!enabled) {
      const request = activePanel
      activePanel = null
      if (request) dismissPanelAfter(request)
      else void dismissSystemDragPanel()
    }
  }
  const updateDocumentSelection = (preserveCaptured = false) => {
    if (!observed()) return
    const current = document.getSelection()
    if (
      !current ||
      current.isCollapsed ||
      current.rangeCount === 0 ||
      !selectionInsideWorkspace(current)
    ) {
      if (!preserveCaptured)
        setSelection(previous => (previous?.source === 'workspace-document' ? null : previous))
      return
    }
    const text = current.toString().trim()
    const rect = usableSelectionRect(current)
    if (!text || !rect) {
      if (!preserveCaptured)
        setSelection(previous => (previous?.source === 'workspace-document' ? null : previous))
      return
    }
    setSelection({ source: 'workspace-document', text, rect })
  }
  const scheduleSelection = () => scheduleFrame(() => updateDocumentSelection(true))
  const finalizeSelection = () => updateDocumentSelection()
  const selectedTextChanged = (event: Event) => {
    if (!observed()) return
    const { source, text, rect } = (event as CustomEvent<SelectedTextChangedDetail>).detail
    setSelection(previous => {
      if (text && rect) return { source, text, rect }
      if (text) return previous?.source === source ? previous : null
      return previous?.source === source ? null : previous
    })
  }
  const dragStart = (event: DragEvent) => {
    if (!observed() || !enabled || !event.dataTransfer) return
    let text = prepareSelectedTextDrag(event)?.trim() ?? ''
    const source = selectionElement(event.target as Node | null)
    if (!text && selection && closestComposed(source, WORKSPACE_SELECTION_ROOT_SELECTOR)) {
      text = selection.text
      writeSelectedTextDragData(event.dataTransfer, text)
    }
    if (!text && !hasWorkspacePathDragData(event.dataTransfer)) return
    setSelection(null)
    activePanel = invokeDesktopHost<number>('systemDrag.showPanel').catch(error => {
      console.error('[Wework] Failed to show system drag panel:', error)
      return undefined
    })
  }
  const dragEnd = () => {
    if (!observed()) return
    const request = activePanel
    activePanel = null
    if (request) dismissPanelAfter(request)
    else void dismissSystemDragPanel()
  }
  function start() {
    let disposed = false
    const initialPreferencesRevision = preferencesRevision
    void getAppPreferences()
      .then(preferences => {
        if (observed() && !disposed && preferencesRevision === initialPreferencesRevision)
          enabled = preferences.systemDragEnabled
      })
      .catch(error => console.error('[Wework] Failed to read system drag preferences:', error))
    let pending = false
    let dirty = false
    const takePending = async () => {
      if (disposed || !observed()) return
      if (pending) {
        dirty = true
        return
      }
      dirty = false
      pending = true
      try {
        const payloads = await invokeDesktopHost<SystemDropPayload[]>('systemDrag.takePending', {
          windowLabel: getDesktopWindowLabel(),
        })
        if (!disposed && observed()) payloads.forEach(handlePayload)
      } catch (error) {
        if (!disposed) reportTransferError(error)
      } finally {
        pending = false
        if (dirty) void takePending()
      }
    }
    const unsubscribe = subscribeDesktopHostEvents(event => {
      if (event.type === 'systemDrag.pending') void takePending()
    })
    void takePending()
    stop = () => {
      disposed = true
      unsubscribe()
      frames.forEach(frame => cancelAnimationFrame(frame))
      frames.clear()
      timers.forEach(timer => clearTimeout(timer))
      timers.clear()
      const request = activePanel
      activePanel = null
      if (request) dismissPanelAfter(request)
    }
  }
  return {
    preferencesChanged,
    scheduleSelection,
    finalizeSelection,
    selectedTextChanged,
    dragStart,
    dragEnd,
    getSnapshot: () => selection,
    subscribe(next: WorkbenchContextValue, listener: () => void) {
      if (context && (targetKey(context) !== targetKey(next) || context.services !== next.services))
        generation++
      context = next
      listeners.add(listener)
      const nextTitle =
        findRuntimeTask(next.state.runtimeWork, next.state.currentRuntimeTask)?.title ?? null
      if (title !== nextTitle) {
        title = nextTitle
        void invokeDesktopHost('systemDrag.setContext', { conversationTitle: title }).catch(error =>
          console.error('[Wework] Failed to set system drag context:', error)
        )
      }
      if (!stop) start()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          generation++
          stop?.()
          stop = null
          context = null
          title = undefined
        })
      }
    },
    addSelectionToConversation() {
      if (!observed() || !selection) return
      const current = context!
      const owner = generation
      current.projectChat.setInput(
        current.projectChat.input
          ? `${current.projectChat.input}\n${selection.text}`
          : selection.text
      )
      setSelection(null)
      document.getSelection()?.removeAllRanges()
      scheduleFrame(() => {
        if (owner !== generation) return
        document
          .querySelector<HTMLElement>(
            '[data-testid="desktop-floating-composer-card"] [data-testid="chat-message-input"]'
          )
          ?.focus()
      })
    },
  }
}
