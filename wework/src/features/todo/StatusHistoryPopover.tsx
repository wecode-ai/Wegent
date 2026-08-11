import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { memberNameById } from './todoShared'

type StatusHistoryEntry = NonNullable<CloudLoopItem['status_history']>[number]

const STATUS_ACTION_KEYS: Record<StatusHistoryEntry['trigger'], string> = {
  create: 'todo.status_action_create',
  user_update: 'todo.status_action_user_update',
  ai_started: 'todo.status_action_ai_started',
  ai_completed: 'todo.status_action_ai_completed',
  task_started: 'todo.status_action_task_started',
  delivery: 'todo.status_action_delivery',
  status_removed: 'todo.status_action_status_removed',
}

interface StatusHistoryPopoverProps {
  anchor: HTMLElement | null
  entries: StatusHistoryEntry[]
  projectMembers: CloudProjectMember[]
  onClose: () => void
}

const POPOVER_WIDTH = 280
const POPOVER_GAP = 8
const POPOVER_MARGIN = 16
const POPOVER_HEIGHT_ESTIMATE = 240

export function StatusHistoryPopover({
  anchor,
  entries,
  projectMembers,
  onClose,
}: StatusHistoryPopoverProps) {
  const { t } = useTranslation('common')
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{
    left: number
    top?: number
    bottom?: number
  } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const spaceAbove = rect.top
      const spaceBelow = window.innerHeight - rect.bottom
      const placeAbove = spaceAbove >= POPOVER_HEIGHT_ESTIMATE || spaceAbove >= spaceBelow
      setPosition({
        left: Math.max(
          POPOVER_MARGIN,
          Math.min(
            rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
            window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN
          )
        ),
        bottom: placeAbove ? window.innerHeight - rect.top + POPOVER_GAP : undefined,
        top: !placeAbove ? rect.bottom + POPOVER_GAP : undefined,
      })
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popoverRef.current?.contains(target) && !anchor?.contains(target)) {
        onClose()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [anchor, onClose])

  if (!anchor || !position) return null

  return createPortal(
    <div
      ref={popoverRef}
      data-testid="cloud-todo-status-history-popover"
      role="dialog"
      aria-label={t('todo.status_history_title', '状态历史')}
      className="fixed z-system-popover w-[280px] rounded-xl border border-border/70 bg-background p-1 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      style={{ left: position.left, bottom: position.bottom, top: position.top }}
    >
      <p className="px-2 pb-1.5 pt-2 text-xs font-medium text-text-primary">
        {t('todo.status_history_title', '状态历史')}
      </p>
      <div className="max-h-[264px] overflow-y-auto px-1 pb-1">
        {entries.map((entry, index) => {
          const byName = memberNameById(projectMembers, entry.by_user_id)
          const actor = byName ?? t('todo.status_history_system', '系统/机器人')
          const toName = entry.to_status_name || t('todo.status_history_unset', '未设置')
          const isCreate = entry.trigger === 'create'
          const isAccept =
            entry.trigger === 'user_update' &&
            entry.from_status === 'in_review' &&
            entry.to_status === 'completed'
          const actionLabel = isAccept
            ? t('todo.status_action_accept', '验收')
            : t(
                STATUS_ACTION_KEYS[entry.trigger] ?? 'todo.status_action_user_update',
                entry.trigger
              )
          return (
            <div
              key={`${entry.at}-${index}`}
              className="rounded-md px-1.5 py-1.5"
              data-testid={`cloud-todo-status-history-entry-${index}`}
            >
              <div className="flex items-center gap-1.5 text-xs text-text-primary">
                <span className="shrink-0 font-medium">{actor}</span>
                {isCreate ? (
                  <>
                    <span className="shrink-0 text-text-muted">
                      {t('todo.status_history_initial', '初始状态')}
                    </span>
                    <span className="min-w-0 truncate">{toName}</span>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 truncate">
                      {entry.from_status_name || t('todo.status_history_unset', '未设置')}
                    </span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" />
                    <span className="min-w-0 truncate">{toName}</span>
                  </>
                )}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                {actionLabel} · {new Date(entry.at).toLocaleString()}
              </p>
            </div>
          )
        })}
      </div>
    </div>,
    document.body
  )
}
