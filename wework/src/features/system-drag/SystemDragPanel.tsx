import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { MessageSquarePlus, CornerDownRight, Archive, Check, AlertCircle, X } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

type DropAction = 'new-chat' | 'follow-up' | 'stash'
type DropStatus = { kind: 'success' | 'error'; action: DropAction } | null

const FEEDBACK_DURATION_MS = 800
const DROP_DEDUP_WINDOW_MS = 500

export function SystemDragPanel() {
  const { t } = useTranslation('common')
  const [activeAction, setActiveAction] = useState<DropAction | null>(null)
  const [conversationTitle, setConversationTitle] = useState<string | null>(null)
  const [dropStatus, setDropStatus] = useState<DropStatus>(null)
  const lastTextDropRef = useRef<{ key: string; timestamp: number } | null>(null)

  const dismiss = useCallback(() => {
    setDropStatus(null)
    setActiveAction(null)
    void invokeDesktopHost('systemDrag.dismissPanel')
  }, [])

  useEscapeKey(dismiss)

  useEffect(() => {
    document.documentElement.dataset.systemDragPanel = 'true'
    return () => {
      delete document.documentElement.dataset.systemDragPanel
    }
  }, [])

  const complete = async (action: DropAction, text: string | null, paths: string[]) => {
    try {
      const payload = { action, text, paths }
      await invokeDesktopHost('systemDrag.complete', { payload })
      setDropStatus({ kind: 'success', action })
    } catch (error) {
      console.error('[Wework] Failed to complete system drop:', error)
      setDropStatus({ kind: 'error', action })
    }
    window.setTimeout(() => {
      void invokeDesktopHost('systemDrag.dismissPanel')
      setDropStatus(null)
      setActiveAction(null)
    }, FEEDBACK_DURATION_MS)
  }

  useEffect(() => {
    void invokeDesktopHost<{ conversationTitle: string | null }>('systemDrag.getContext').then(
      context => setConversationTitle(context.conversationTitle)
    )
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
    <main data-testid="system-drag-panel" className="mx-auto h-[60px] w-[440px] bg-transparent p-1">
      <section className="relative h-full overflow-hidden rounded-xl border border-border bg-background/95 shadow-lg backdrop-blur-md">
        <div className="flex h-full">
          <aside
            data-testid="system-drag-brand"
            className="pointer-events-none flex w-16 shrink-0 flex-col items-center justify-center gap-0.5 border-r border-border/70 bg-muted/40"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-text-primary text-xs font-bold text-background">
              W
            </span>
            <span className="text-xs font-semibold leading-none tracking-tight text-text-secondary">
              Wework
            </span>
          </aside>
          {dropStatus && completedZone ? (
            <div
              data-testid={`system-drag-${dropStatus.kind}-feedback`}
              className="flex min-w-0 flex-1 items-center justify-center gap-2 px-4 text-center"
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
            <div className="flex min-w-0 flex-1 items-stretch p-1">
              {zones
                .filter(zone => zone.action !== 'follow-up' || conversationTitle)
                .map(({ action, icon: Icon, title, detail }) => (
                  <div
                    key={action}
                    data-testid={`system-drag-${action}-zone`}
                    className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 text-left transition-colors duration-150 after:absolute after:-right-0.5 after:top-2 after:h-[calc(100%-1rem)] after:w-px after:bg-border last:after:hidden ${activeAction === action ? 'border-text-primary/15 bg-muted shadow-sm' : 'border-transparent'}`}
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
                      <div className="truncate text-xs leading-none text-text-muted">
                        {activeAction === action
                          ? t('workbench.system_drag_release', '松开即可添加')
                          : detail}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
          <div
            className="flex w-8 shrink-0 items-center justify-center"
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              dismiss()
            }}
          >
            <button
              type="button"
              data-testid="system-drag-close-button"
              aria-label={t('common.close', '关闭')}
              onClick={dismiss}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}
