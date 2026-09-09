import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { ChangeRequestStatusIcon } from '@/components/common/ChangeRequestStatusIcon'
import type { CloudTodoBoardTaskBinding } from '@/features/todo/CloudTodoBoardCard'

interface GitBoardCardStatusProps {
  binding: CloudTodoBoardTaskBinding
  compact: boolean
  itemId: string
  onContinueRepair?: () => Promise<void>
  repairing?: boolean
  snapshot: TaskChangeRequestSnapshot | null
}

export default function GitBoardCardStatus({
  binding,
  compact,
  itemId,
  onContinueRepair,
  repairing = false,
  snapshot,
}: GitBoardCardStatusProps) {
  if (!snapshot?.changeRequest) return null

  return (
    <ChangeRequestStatusIcon
      snapshot={snapshot}
      testId={`cloud-todo-card-change-request-${itemId}-${binding.id}`}
      className={compact ? 'absolute right-0 top-0 z-10' : undefined}
      popoverAlign="left"
      repairing={repairing}
      onContinueRepair={onContinueRepair}
    />
  )
}
