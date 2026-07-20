import { useEffect, useRef, useState, type DragEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { DragDropEvent } from '@tauri-apps/api/window'
import { emit, listen } from '@tauri-apps/api/event'
import { MessageSquarePlus, CornerDownRight, Archive, Check, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

type DropAction = 'new-chat' | 'follow-up' | 'stash'
type DropStatus = { kind: 'success' | 'error'; action: DropAction } | null
type NativeTextDropPayload = { text: string; x: number }

const FEEDBACK_DURATION_MS = 800
const DROP_DEDUP_WINDOW_MS = 500
const PANEL_WIDTH = 440

function actionAtPosition(x: number, hasConversation: boolean): DropAction {
  if (!hasConversation) return x < PANEL_WIDTH / 2 ? 'new-chat' : 'stash'
  if (x < PANEL_WIDTH / 3) return 'new-chat'
  if (x < (PANEL_WIDTH / 3) * 2) return 'follow-up'
  return 'stash'
}

export function SystemDragPanel() {
  const { t } = useTranslation('common')
  const [activeAction, setActiveAction] = useState<DropAction | null>(null)
  const [conversationTitle, setConversationTitle] = useState<string | null>(null)
  const [dropStatus, setDropStatus] = useState<DropStatus>(null)
  const lastFileDropRef = useRef<{ key: string; timestamp: number } | null>(null)
  const lastTextDropRef = useRef<{ key: string; timestamp: number } | null>(null)
  const lastOverLogRef = useRef<{ x: number; timestamp: number } | null>(null)

  useEffect(() => {
    document.documentElement.dataset.systemDragPanel = 'true'
    return () => {
      delete document.documentElement.dataset.systemDragPanel
    }
  }, [])

  const complete = async (action: DropAction, text: string | null, paths: string[]) => {
    try {
      await invoke('complete_system_drag_drop', { payload: { action, text, paths } })
      setDropStatus({ kind: 'success', action })
    } catch (error) {
      console.error('[Wework] Failed to complete system drop:', error)
      setDropStatus({ kind: 'error', action })
    }
    window.setTimeout(() => {
      void invoke('dismiss_system_drag_panel')
      setDropStatus(null)
      setActiveAction(null)
    }, FEEDBACK_DURATION_MS)
  }

  useEffect(() => {
    let cancelled = false
    let dispose: (() => void) | undefined
    void listen<NativeTextDropPayload>('wework-system-drag-native-text-drop', event => {
      const text = event.payload.text.trim()
      if (!text) return
      const action = actionAtPosition(event.payload.x, Boolean(conversationTitle))
      const key = `${action}:${text}`
      const now = Date.now()
      const previous = lastTextDropRef.current
      if (previous?.key === key && now - previous.timestamp < DROP_DEDUP_WINDOW_MS) return
      lastTextDropRef.current = { key, timestamp: now }
      setActiveAction(action)
      void complete(action, text, [])
    }).then(unlisten => {
      if (cancelled) unlisten()
      else dispose = unlisten
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [conversationTitle])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent(event => {
        const payload: DragDropEvent = event.payload
        if (payload.type === 'leave') {
          setActiveAction(null)
          return
        }
        const action = actionAtPosition(payload.position.x, Boolean(conversationTitle))
        if (payload.type === 'over' || payload.type === 'enter') {
          const now = Date.now()
          const previous = lastOverLogRef.current
          if (
            !previous ||
            Math.abs(previous.x - payload.position.x) >= 20 ||
            now - previous.timestamp >= 250
          ) {
            lastOverLogRef.current = { x: payload.position.x, timestamp: now }
            void invoke('log_system_drag_debug', {
              stage: `webview_${payload.type}`,
              action,
              x: payload.position.x,
              y: payload.position.y,
            })
          }
        }
        setActiveAction(action)
        if (payload.type === 'drop' && payload.paths.length > 0) {
          const paths = [...new Set(payload.paths)]
          const key = `${action}:${[...paths].sort().join('\u0000')}`
          const now = Date.now()
          const previous = lastFileDropRef.current
          const duplicate = Boolean(
            previous?.key === key && now - previous.timestamp < DROP_DEDUP_WINDOW_MS
          )
          void invoke('log_system_drag_debug', {
            stage: 'webview_drop',
            action,
            rawPathCount: payload.paths.length,
            uniquePathCount: paths.length,
            duplicate,
            x: payload.position.x,
            y: payload.position.y,
          })
          if (duplicate) return
          lastFileDropRef.current = { key, timestamp: now }
          void complete(action, null, paths)
        }
      })
      .then(dispose => {
        if (cancelled) dispose()
        else unlisten = dispose
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [conversationTitle])

  useEffect(() => {
    let cancelled = false
    let dispose: (() => void) | undefined
    void listen<{ conversationTitle: string | null }>('wework-system-drag-context', event => {
      setConversationTitle(event.payload.conversationTitle)
    }).then(unlisten => {
      if (cancelled) unlisten()
      else {
        dispose = unlisten
        void emit('wework-system-drag-context-requested')
      }
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  const handleTextDrop = (action: DropAction, event: DragEvent<HTMLDivElement>) => {
    const text = event.dataTransfer.getData('text/plain').trim()
    event.preventDefault()
    setActiveAction(action)
    if (!text) return
    const key = `${action}:${text}`
    const now = performance.timeOrigin + event.timeStamp
    const previous = lastTextDropRef.current
    if (previous?.key === key && now - previous.timestamp < DROP_DEDUP_WINDOW_MS) return
    lastTextDropRef.current = { key, timestamp: now }
    void complete(action, text, [])
  }

  const zones = [
    {
      action: 'new-chat' as const,
      icon: MessageSquarePlus,
      title: t('workbench.system_drag_new_chat', '创建新对话'),
      detail: t('workbench.system_drag_new_chat_detail', '填入新对话草稿'),
    },
    {
      action: 'follow-up' as const,
      icon: CornerDownRight,
      title: t('workbench.system_drag_follow_up', '追问'),
      detail: conversationTitle ?? t('workbench.system_drag_follow_up_detail', '附加到当前对话'),
    },
    {
      action: 'stash' as const,
      icon: Archive,
      title: t('workbench.system_drag_stash', '临时暂存'),
      detail: t('workbench.system_drag_stash_detail', '保存到快捷短语暂存区'),
    },
  ]
  const completedZone = dropStatus
    ? zones.find(zone => zone.action === dropStatus.action)
    : undefined

  return (
    <main data-testid="system-drag-panel" className="mx-auto h-[72px] w-[440px] bg-transparent p-1">
      <section className="relative h-full overflow-hidden rounded-xl border border-border bg-background/95 shadow-lg backdrop-blur-md">
        <div
          data-testid="system-drag-brand"
          className="pointer-events-none absolute left-1/2 top-1 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-semibold leading-none tracking-[0.02em] text-text-secondary shadow-sm"
        >
          Wework
        </div>
        {dropStatus && completedZone ? (
          <div
            data-testid={`system-drag-${dropStatus.kind}-feedback`}
            className="flex h-full items-center justify-center gap-2 px-4 pt-2 text-center"
            role="status"
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-lg ${dropStatus.kind === 'success' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}
            >
              {dropStatus.kind === 'success' ? (
                <Check className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
            </span>
            <div>
              <div className="text-xs font-medium">
                {dropStatus.kind === 'success'
                  ? t('workbench.system_drag_added', '已添加')
                  : t('workbench.system_drag_failed', '添加失败')}
              </div>
              <div className="text-xs text-text-muted">{completedZone.title}</div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-stretch p-1 pt-2.5">
            {zones
              .filter(zone => zone.action !== 'follow-up' || conversationTitle)
              .map(({ action, icon: Icon, title, detail }) => (
                <div
                  key={action}
                  data-testid={`system-drag-${action}-zone`}
                  className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 text-left transition-colors duration-150 after:absolute after:-right-0.5 after:top-2 after:h-[calc(100%-1rem)] after:w-px after:bg-border last:after:hidden ${activeAction === action ? 'border-text-primary/15 bg-muted shadow-sm' : 'border-transparent'}`}
                  onDragOver={event => {
                    event.preventDefault()
                    setActiveAction(action)
                  }}
                  onDrop={event => handleTextDrop(action, event)}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${activeAction === action ? 'bg-text-primary text-background' : 'bg-muted text-text-secondary'}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 max-w-full">
                    <div className="truncate text-xs font-medium">{title}</div>
                    <div className="truncate text-xs leading-none text-text-muted">{detail}</div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
    </main>
  )
}
