export interface MessageListScrollMetrics {
  contentOffset: { y: number }
  contentSize: { height: number }
  layoutMeasurement: { height: number }
}

interface ResolveMessageListFollowOptions {
  currentlyFollowing: boolean
  metrics: MessageListScrollMetrics
  userInitiated: boolean
}

export type MessageListFollowEvent =
  | { type: 'conversation-entered' }
  | {
      type: 'scroll-position-changed'
      metrics: MessageListScrollMetrics
      userInitiated: boolean
    }

const BOTTOM_FOLLOW_THRESHOLD = 48

export function messageListBottomOffset(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight)
}

export function isNearMessageListBottom(metrics: MessageListScrollMetrics): boolean {
  const distance =
    metrics.contentSize.height - metrics.layoutMeasurement.height - metrics.contentOffset.y
  return distance <= BOTTOM_FOLLOW_THRESHOLD
}

export function resolveMessageListFollow({
  currentlyFollowing,
  metrics,
  userInitiated,
}: ResolveMessageListFollowOptions): boolean {
  if (!userInitiated) return currentlyFollowing
  return isNearMessageListBottom(metrics)
}

export function reduceMessageListFollow(
  currentlyFollowing: boolean,
  event: MessageListFollowEvent
): boolean {
  if (event.type === 'conversation-entered') return true
  return resolveMessageListFollow({
    currentlyFollowing,
    metrics: event.metrics,
    userInitiated: event.userInitiated,
  })
}
