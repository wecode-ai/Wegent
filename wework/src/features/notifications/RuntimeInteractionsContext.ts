import { createContext, useContext } from 'react'
import type { InteractionSource, RuntimeInteraction } from './runtimeInteractions'
import type { ValidatedIssueResolution } from './issueHumanInteractions'

export interface InteractionHistory {
  source?: InteractionSource
  id: string
  title: string
  question: string
  address?: RuntimeInteraction['task']['address']
  originalUrl?: string
  sourceMessageIds?: string[]
  answeredAt: number
  dismissed?: true
  dismissedHandoff?: string
  dismissedQuestionIdentity?: string
  resolvedIssueQuestion?: ValidatedIssueResolution
}

export interface RuntimeInteractionsValue {
  projectItemsSupported?: boolean
  pendingProjectCount?: number | null
  reportProjectPendingCount?: (count: number | null) => void
  pending: RuntimeInteraction[]
  history: InteractionHistory[]
  errors: Record<string, string>
  drafts: Record<string, string>
  replyDrafts: InteractionReplyDraft[]
  busy: ReadonlySet<string>
  loading: boolean
  setDraft: (id: string, text: string) => void
  discardDraft: (id: string) => Promise<boolean>
  respond: (
    item: RuntimeInteraction,
    answer: string,
    options?: { clientMessageId?: string; send?: () => Promise<boolean> }
  ) => Promise<boolean>
  dismiss: (item: RuntimeInteraction | InteractionHistory) => Promise<void>
  isDismissed?: (id: string, questionIdentity?: string | null, handoff?: string) => boolean
  refresh: () => Promise<void>
  open: (id?: string) => void
  notice: RuntimeInteraction | null
  dismissNotice: () => void
  registerView: (owner: string, id: string | null) => void
}

export interface InteractionReplyDraft {
  text: string
  interaction: InteractionHistory
  nativeReplyIds: string[]
}

export const RuntimeInteractionsContext = createContext<RuntimeInteractionsValue | null>(null)

export function useRuntimeInteractions() {
  return useContext(RuntimeInteractionsContext)
}

export const INTERACTIONS_PATH = '/pending-interactions'
export const INTERACTIONS_TAB_ID = 'pending-interactions'
