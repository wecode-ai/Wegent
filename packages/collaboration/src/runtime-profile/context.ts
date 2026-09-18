import { createContext, useContext } from 'react'
import type { WorkspaceRuntimeProfile } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecution, CollaborationIssue } from '../types'

export type Configured = (profile: WorkspaceRuntimeProfile) => Promise<void>
export interface ProfileConfigurationTarget {
  title: string
  description: string
  saveLabel: string
  savedLabel: string
  apply: Configured
}
export const RuntimeProfilePickerContext = createContext<
  ((target: ProfileConfigurationTarget) => void) | null
>(null)
export function useRuntimeProfilePicker() {
  return useContext(RuntimeProfilePickerContext)
}
export const ExecutionRuntimeConfigurationContext = createContext<
  | ((
      issue: Pick<
        CollaborationIssue,
        'id' | 'execution_id' | 'assignee_agent_id'
      >,
      onConfigured: (execution: CollaborationExecution) => void,
    ) => Promise<void>)
  | null
>(null)
export function useExecutionRuntimeConfiguration() {
  return useContext(ExecutionRuntimeConfigurationContext)
}
export const RuntimeConfigurationContext = createContext<
  ((onConfigured?: Configured) => void) | null
>(null)
export const RuntimeConfigurationRevisionContext = createContext(0)

export function useRuntimeConfigurationRevision() {
  return useContext(RuntimeConfigurationRevisionContext)
}

export function useRuntimeConfiguration() {
  return useContext(RuntimeConfigurationContext)
}
