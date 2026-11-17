import type { ComponentProps, ReactNode } from 'react'
import { visibleRuntimeGoal } from '@/lib/runtime-goal'
import { connectionGoalWaitState } from '@/lib/runtime-connection-events'
import { GoalStatusBar } from './GoalStatusBar'
import { ConnectionEventStatus } from './ConnectionEventStatus'

type Props = Omit<ComponentProps<typeof GoalStatusBar>, 'goal' | 'eventWaitState'> & {
  goal?: ComponentProps<typeof GoalStatusBar>['goal'] | null
  goalDraftActive?: boolean
  subscriptions?: unknown
  eventSubscriptionScope?: string
  onCancelEventSubscription?: (key: string) => Promise<void>
  eventCancellationUnavailable?: boolean
  eventCancellationUnsupported?: boolean
  interactionStatus?: ComponentProps<typeof ConnectionEventStatus>['interactionStatus']
  children?: ReactNode
}

/** Preserve the same execution context beside ordinary input and pending questions. */
export function ConversationEventContext({
  goal,
  goalDraftActive,
  subscriptions,
  eventSubscriptionScope,
  onCancelEventSubscription,
  eventCancellationUnavailable,
  eventCancellationUnsupported,
  interactionStatus,
  children,
  ...goalProps
}: Props) {
  const displayedGoal = visibleRuntimeGoal(goal)
  return (
    <>
      {displayedGoal && !goalDraftActive && (
        <GoalStatusBar
          {...goalProps}
          goal={displayedGoal}
          eventWaitState={connectionGoalWaitState(subscriptions)}
        />
      )}
      {children}
      <ConnectionEventStatus
        key={eventSubscriptionScope}
        subscriptions={subscriptions}
        interactionStatus={interactionStatus}
        onCancel={onCancelEventSubscription}
        unavailable={eventCancellationUnavailable}
        unsupported={eventCancellationUnsupported}
      />
    </>
  )
}
