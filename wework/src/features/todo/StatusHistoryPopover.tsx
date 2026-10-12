import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { IssueStatusHistoryList } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { AnchorPopover } from './AnchorPopover'
import { memberNameById } from './todoShared'
import { statusHistoryLabels } from './statusHistoryLabels'

type StatusHistoryEntry = NonNullable<CloudLoopItem['status_history']>[number]

interface StatusHistoryPopoverProps {
  anchor: HTMLElement | null
  entries: StatusHistoryEntry[]
  projectMembers: CloudProjectMember[]
  onClose: () => void
}

export function StatusHistoryPopover({
  anchor,
  entries,
  projectMembers,
  onClose,
}: StatusHistoryPopoverProps) {
  const { t } = useTranslation('common')
  return (
    <AnchorPopover
      anchor={anchor}
      title={t('todo.status_history_title', '状态历史')}
      testId="cloud-todo-status-history-popover"
      onClose={onClose}
    >
      <IssueStatusHistoryList
        entries={entries}
        memberName={userId => memberNameById(projectMembers, userId)}
        labels={statusHistoryLabels(t)}
      />
    </AnchorPopover>
  )
}
