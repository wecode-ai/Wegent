import type { RefObject } from 'react'
import type { WorkbenchMessage } from '@wegent/chat-core'
import type { RuntimeTurnNavigationItem } from '@wegent/chat-core/runtime'
import type { CollaborationTranslate } from '../i18n'

export type NavigationMessage = Pick<
  WorkbenchMessage,
  'id' | 'role' | 'content' | 'blocks' | 'source'
> & {
  turnId?: string | null
  runtimeGuidance?: boolean | null
  runtimeMessageIndex?: number | null
}

export interface ConversationMessageTarget {
  messageId: string
  requestKey: string
}

export interface MessageTurnNavigationProps {
  messageTarget?: ConversationMessageTarget
  translate: CollaborationTranslate
  messages: NavigationMessage[]
  turnNavigation?: RuntimeTurnNavigationItem[]
  scrollRef: RefObject<HTMLDivElement | null>
  interactionRef?: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onLoadTurnNavigationItem?: (item: RuntimeTurnNavigationItem) => Promise<void> | void
  onNavigationLoadStateChange?: (loading: boolean) => void
  onNavigationScrollTargetChange?: (messageId: string | null) => void
  portalTarget?: Element | null
  /** Height of a bottom overlay, such as a sticky composer, that hides part of the scroll viewport. */
  bottomInsetPx?: number
}

export interface UserTurn {
  id: string
  userMessageId?: string | null
  runtimeGuidance?: boolean | null
  turnId?: string | null
  turnIndex: number
  messageIndex: number
  promptPreview: string
  responsePreview: string
  cursor?: string | null
  loaded: boolean
}

export interface MessageTurnMarker extends UserTurn {
  targetTop: number | null
  visibleTop: number | null
  visibleBottom: number | null
}

export interface PendingScrollTarget {
  navigationId: string
  userMessageId?: string | null
  turnId?: string | null
  messageIndex: number
}

export interface TurnVisibilityBounds {
  top: number
  bottom: number
}

export interface MeasuredScrollGeometry {
  scrollHeight: number
  clientHeight: number
}
