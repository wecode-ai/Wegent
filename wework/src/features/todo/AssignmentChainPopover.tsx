import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { memberNameById } from './todoShared'

type AssignmentEntry = NonNullable<CloudLoopItem['assignment_history']>[number]

interface AssignmentChainPopoverProps {
  anchor: HTMLElement | null
  entries: AssignmentEntry[]
  projectMembers: CloudProjectMember[]
  onClose: () => void
}

const POPOVER_WIDTH = 280
const POPOVER_GAP = 8
const POPOVER_MARGIN = 16
const POPOVER_HEIGHT_ESTIMATE = 240

export function AssignmentChainPopover({
  anchor,
  entries,
  projectMembers,
  onClose,
}: AssignmentChainPopoverProps) {
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
    // Capture-phase so Escape closes the popover before the editor's own
    // Escape handler can close the whole detail panel.
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
      data-testid="cloud-todo-assignment-chain-popover"
      role="dialog"
      aria-label={t('todo.assignment_chain_title', '指派详情')}
      className="fixed z-system-popover w-[280px] rounded-xl border border-border/70 bg-background p-1 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      style={{ left: position.left, bottom: position.bottom, top: position.top }}
    >
      <p className="px-2 pb-1.5 pt-2 text-xs font-medium text-text-primary">
        {t('todo.assignment_chain_title', '指派详情')}
      </p>
      <div className="max-h-[264px] overflow-y-auto px-1 pb-1">
        {entries.map((entry, index) => {
          const byName = memberNameById(projectMembers, entry.by_user_id)
          const toName =
            entry.to_type === 'agent'
              ? (entry.to_name ?? t('todo.assignment_chain_agent', '机器人'))
              : (entry.to_name ?? memberNameById(projectMembers, Number(entry.to_id)))
          const actionLabel = {
            assign: t('todo.assignment_action_assign', '指派'),
            reassign: t('todo.assignment_action_reassign', '转派'),
            unassign: t('todo.assignment_action_unassign', '取消指派'),
          }[entry.action]
          return (
            <div key={`${entry.at}-${index}`} className="rounded-md px-1.5 py-1.5">
              <div className="flex items-center gap-1.5 text-xs text-text-primary">
                <span className="truncate font-medium">{byName ?? `#${entry.by_user_id}`}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" />
                <span className="truncate">
                  {toName ?? t('todo.assignment_chain_unassigned', '未指派')}
                </span>
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
