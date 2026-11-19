import { useMemo, useState } from 'react'
import { useDOMEvent } from '../dom-events'
import {
  createIssueActivityScrollController,
  createIssueActivityListRef,
  type IssueActivityScrollOptions,
} from './issueActivityScrollController'
export { findTaskCommentScrollContainer } from './issueActivityScrollController'

/** Shared PC scroll policy: follow the submitted card, never unrelated incoming activity. */
export function useIssueActivityScroll({
  messages,
  loading,
  issueId,
  readSequence = 0,
  unread = true,
  unreadRevision,
  readRequestKey,
  visibilityRevision,
  onReadSequence,
  linear = true,
  compact = true,
  cardTestIdPrefix,
}: IssueActivityScrollOptions) {
  const [owner] = useState(createIssueActivityScrollController)
  const listRef = useMemo(
    () =>
      createIssueActivityListRef(owner, {
        messages,
        loading,
        issueId,
        readSequence,
        unread,
        unreadRevision,
        readRequestKey,
        visibilityRevision,
        onReadSequence,
        linear,
        compact,
        cardTestIdPrefix,
      }),
    [
      owner,
      messages,
      loading,
      issueId,
      readSequence,
      unread,
      unreadRevision,
      readRequestKey,
      visibilityRevision,
      onReadSequence,
      linear,
      compact,
      cardTestIdPrefix,
    ]
  )
  useDOMEvent('document', 'scroll', owner.onScroll, { capture: true, passive: true })
  return useMemo(
    () => ({
      listRef,
      followCard: owner.followCard,
      scrollTaskCommentsToBottom: owner.scrollTaskCommentsToBottom,
      revealCardBottom: owner.revealCardBottom,
    }),
    [listRef, owner]
  )
}
