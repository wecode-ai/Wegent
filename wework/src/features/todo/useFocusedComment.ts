import type { RefObject } from 'react'
import { useReadableScrollRequest } from '@wegent/collaboration/dom-events'
import { useDeadlineExpired } from '@wegent/collaboration/clock'

const COMMENT_FLASH_MS = 2000

export function useFocusedComment(
  listRef: RefObject<HTMLDivElement | null>,
  messages: readonly unknown[],
  commentId: string | null,
  requestKey: string | null,
  ready = true
): string | null {
  const request = JSON.stringify([commentId, requestKey])
  const receipt = useReadableScrollRequest(listRef, '[data-message-id]', request, {
    enabled: Boolean(commentId),
    ready,
    contentVersion: messages,
    matchAttribute: 'data-message-id',
    matchValue: commentId ?? '',
    occlusionSelector: '.task-detail-comment-bar',
  })
  const deadline = receipt?.request === request ? receipt.locatedAt + COMMENT_FLASH_MS : undefined
  const expired = useDeadlineExpired(deadline)
  return deadline !== undefined && !expired ? commentId : null
}
