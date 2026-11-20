import type {
  ModelSelectionConfig,
  RequestUserInputResponse,
  RuntimeGoal,
  RuntimeGoalCreateInput,
  RuntimeName,
  RuntimeAdditionalContext,
  RuntimeSupervisorCreateInput,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
} from '@/types/api'

export interface WorkbenchPaneSessionOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
  debugSnapshotEnabled?: boolean
}

export interface SendRequestUserInputResponseOptions {
  requestUserInputResponses?: readonly RequestUserInputResponse[]
  appendUserMessage?: boolean
  forceDefaultCollaborationMode?: boolean
}

export interface RuntimePaneSendOptions {
  // Capture before asynchronous submission preparation to protect unpublished edits.
  draftEditVersion?: number
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
  runtime?: RuntimeName
  runtimeExecutablePath?: string
  runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
  modelSelection?: ModelSelectionConfig | null
  additionalContext?: RuntimeAdditionalContext
  cloudProjectId?: string
  origin?: RuntimeTaskCreateRequest['origin']
  initialSupervisor?: RuntimeSupervisorCreateInput | null
  wegentTeamId?: number
  onRuntimeTaskCreated?: (address: RuntimeTaskAddress) => void
  onRuntimeTaskReady?: (address: RuntimeTaskAddress) => void
}

export interface SendRuntimeMessageOptions {
  appendLocalMessage?: boolean
  initialGoal?: RuntimeGoalCreateInput | null
  onError?: (error: string) => void
  silentBusyRetry?: boolean
}

export interface RuntimeMessageSendResult {
  accepted: boolean
  queued: boolean
  queuePosition?: number | null
  guidanceTurnId?: string
}

export interface LoadedTranscriptRange {
  start: number
  end: number
}

export interface RuntimeTaskLoadTarget {
  key: string
  identityKey: string
  address: RuntimeTaskAddress
}

export interface PendingRuntimeGoalState {
  goal: RuntimeGoal
  targetKey: string | null
  targetIdentityKey: string | null
}
