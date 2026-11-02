import { createContext, useContext } from 'react'
import type { RuntimeInteraction } from './runtimeInteractions'

export interface InteractionHistory {
  id: string
  title: string
  question: string
  address: RuntimeInteraction['task']['address']
  originalUrl?: string
  answeredAt: number
}

export interface RuntimeInteractionsValue {
  pending: RuntimeInteraction[]
  history: InteractionHistory[]
  errors: Record<string, string>
  drafts: Record<string, string>
  busy: ReadonlySet<string>
  loading: boolean
  setDraft: (id: string, text: string) => void
  respond: (item: RuntimeInteraction, answer: string) => Promise<boolean>
  refresh: () => Promise<void>
  open: (id?: string) => void
  notice: RuntimeInteraction | null
  dismissNotice: () => void
  registerView: (owner: string, id: string | null) => void
}

export const RuntimeInteractionsContext = createContext<RuntimeInteractionsValue | null>(null)

export function useRuntimeInteractions() {
  return useContext(RuntimeInteractionsContext)
}

export const INTERACTIONS_PATH = '/pending-interactions'
export const INTERACTIONS_TAB_ID = 'pending-interactions'
