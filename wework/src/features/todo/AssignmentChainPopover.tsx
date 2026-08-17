import { ArrowRight } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { AnchorPopover } from './AnchorPopover'
import { memberNameById } from './todoShared'

type AssignmentEntry = NonNullable<CloudLoopItem['assignment_history']>[number]

interface AssignmentChainPopoverProps {
  anchor: HTMLElement | null
  entries: AssignmentEntry[]
  projectMembers: CloudProjectMember[]
  onClose: () => void
}

export function AssignmentChainPopover({
  anchor,
  entries,
  projectMembers,
  onClose,
}: AssignmentChainPopoverProps) {
  const { t } = useTranslation('common')
  return (
    <AnchorPopover
      anchor={anchor}
      title={t('todo.assignment_chain_title', '指派详情')}
      testId="cloud-todo-assignment-chain-popover"
      onClose={onClose}
    >
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
    </AnchorPopover>
  )
}
