import type { RuntimeFailureAction } from './useRuntimeFailures'
import type { RuntimePermissionMode } from '@/services/runtimePermissionPreference'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type {
  Attachment,
  ChatMessage,
  ConversationItem,
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  RuntimeProjectWork,
  UnifiedModel,
  ModelOptions,
  RuntimeAttachment,
  RuntimeComposerApp,
  RuntimeUploadAsset,
  RequestUserInputPayload,
  RequestUserInputResponse,
} from '@/types/runtime'

export interface MobileRuntimeState {
  api: RuntimeApi
  fileTarget: MobileWorkspaceFileTarget | null
  work: RuntimeWorkListResponse
  taskRunningByKey: ReadonlyMap<string, boolean>
  devices: DeviceInfo[]
  cloudConnected: boolean
  failures: RuntimeFailureAction[]
  retryFailure: (failure: RuntimeFailureAction) => Promise<void>
  refreshDevices: () => Promise<string | null>
  conversations: ConversationItem[]
  messages: ChatMessage[]
  currentAddress: RuntimeTaskAddress | null
  currentTitle: string
  setConversationPinned: (address: RuntimeTaskAddress, pinned: boolean) => Promise<void>
  renameConversation: (address: RuntimeTaskAddress, title: string) => Promise<void>
  archiveConversation: (address: RuntimeTaskAddress) => Promise<void>
  selectedWorkspace: RuntimeDeviceWorkspace | null
  selectedDeviceId: string | null
  allDevicesSelected: boolean
  models: UnifiedModel[]
  modelsLoading: boolean
  modelsError: string | null
  loadModels: (force?: boolean) => Promise<void>
  loadLocalModels: () => Promise<void>
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  permissionMode: RuntimePermissionMode
  loading: boolean
  listSnapshotReady: boolean
  conversationLoading: boolean
  historyLoaded: boolean
  hasMoreMessagesBefore: boolean
  loadingMoreMessagesBefore: boolean
  refreshing: boolean
  sending: boolean
  running: boolean
  stopping: boolean
  error: string | null
  connectionError: string | null
  refresh: () => Promise<void>
  loadMoreMessagesBefore: () => Promise<void>
  openConversation: (item: ConversationItem) => Promise<void>
  startNewConversation: (workspace?: RuntimeDeviceWorkspace) => void
  selectDevice: (deviceId: string) => void
  selectAllDevices: () => void
  selectWorkspace: (workspace: RuntimeDeviceWorkspace | null) => void
  selectModel: (model: UnifiedModel, options?: ModelOptions) => void
  selectPermissionMode: (mode: RuntimePermissionMode) => void
  send: (message: string, options?: NewConversationOptions) => Promise<boolean>
  stop: () => Promise<boolean>
  respondToUserInput: (response: RequestUserInputResponse) => Promise<boolean>
  skipUserInput: (payload: RequestUserInputPayload) => Promise<boolean>
  uploadAttachment: (asset: RuntimeUploadAsset) => Promise<RuntimeAttachment>
  loadComposerApps: () => Promise<RuntimeComposerApp[]>
  createProject: (input: { deviceId: string; workspacePath: string; name: string }) => Promise<void>
  setProjectPinned: (project: RuntimeProjectWork, pinned: boolean) => Promise<void>
  renameProject: (project: RuntimeProjectWork, name: string) => Promise<void>
  removeProject: (project: RuntimeProjectWork) => Promise<void>
  refreshWork: (deviceId: string) => Promise<unknown>
  clearError: () => void
}

export interface NewConversationOptions {
  executionMode?: 'current_workspace' | 'git_worktree'
  worktreeBranch?: string | null
  attachmentIds?: number[]
  attachments?: Attachment[]
  pursueGoal?: boolean
}
