import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { AssistantInteractionRequest } from '@wegent/collaboration'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import { type PrivateHistorySource } from '@/features/collaboration-exp/private/privateConversationHistory'
import type { ConversationModelControls } from './conversationModelControls'
import { type ReactNode } from 'react'
import { type RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import type { ProjectWithTasks, RuntimeSendRequest, RuntimeTaskAddress } from '@/types/api'
import type { RuntimeTaskComposerCreateOptions } from '@/types/workbench'
export interface TemporaryChatPanelProps {
  currentProject: ProjectWithTasks | null
  source: RuntimeTaskAddress | null
  instanceId: string
  testId?: string
  initialInput?: string
  draftRequest?: { id: number; text: string }
  onDraftRequestConsumed?(id: number): void
  autoSubmitInitialInput?: boolean
  initialAddress?: RuntimeTaskAddress | null
  controlledAddress?: RuntimeTaskAddress | null
  draft?: {
    value: string
    onChange(value: string): void
    beginSubmission?(value: string): {
      clientMessageId: string
      clearIfUnchanged(): void
      release(): void
    }
  }
  createTask?: (
    message: string,
    options: RuntimeTaskComposerCreateOptions
  ) => Promise<RuntimeTaskAddress | false>
  assistantSend?: (input: {
    message: string
    clientUserMessageId: string
    attachmentIds?: number[]
    interruptWhenBusy?: boolean
    runtimeOptions?: AssistantInteractionRequest['runtimeOptions']
  }) => Promise<{ sent: boolean; queued?: boolean; error?: string | null }>
  onAddressChange?: (address: RuntimeTaskAddress | null) => void
  runtimeContext?: Pick<
    RuntimeSendRequest,
    'cloudProjectId' | 'origin' | 'additionalContext' | 'conversationContext' | 'assistantPrompt'
  >
  sendEphemeral?: boolean
  emptyStateText?: string
  placeholder?: string
  showExecutionTools?: boolean
  showModelSelector?: boolean
  hideProcessing?: boolean
  assistantMessageStyle?: 'plain' | 'bubble'
  markReadWhenActive?: boolean
  nativeConversation?: boolean
  allowMessagesDuringApproval?: boolean
  modelControls?: ConversationModelControls
  allowInitialGoal?: boolean
  expanded?: boolean
  wideComposer?: boolean
  showWorkbenchBackground?: boolean
  collapseComposerWhenIdle?: boolean
  readOnly?: boolean
  active?: boolean
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
  projectWorkBarMiddleContext?: ReactNode
  projectWorkBarTrailingContext?: ReactNode
  composerHeader?: ReactNode
  contentFooter?: ReactNode
  renderMessageGaps?: (messages: WorkbenchMessage[]) => ReadonlyMap<string, ReactNode>
  onRestoreConversation?: () => void
  onFillSelectionToAnswer?: (text: string) => void
  initialScrollPosition?: 'restore' | 'latest'
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  coordinateUserInput?: boolean
  focusedRequest?: RequestUserInputPayload | null
  sourceMessageIds?: string[]
  historySource?: PrivateHistorySource
  historySourceUnavailableText?: string
  onHistorySourceAvailabilityChange?(available: boolean): void
  focusRequestKey?: string
}
