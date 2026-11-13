import type { RuntimePermissionMode } from '@/services/runtimePermissionPreference'
import type {
  ChatMessage,
  ConversationItem,
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
  ModelOptions,
  RuntimeAttachment,
  RuntimeComposerApp,
  RuntimeUploadAsset,
  RequestUserInputPayload,
  RequestUserInputResponse,
} from '@/types/runtime'

export interface MobileRuntimeState {
  work: RuntimeWorkListResponse
  devices: DeviceInfo[]
  conversations: ConversationItem[]
  messages: ChatMessage[]
  currentAddress: RuntimeTaskAddress | null
  currentTitle: string
  selectedWorkspace: RuntimeDeviceWorkspace | null
  selectedDeviceId: string | null
  allDevicesSelected: boolean
  models: UnifiedModel[]
  modelsLoading: boolean
  modelsError: string | null
  loadModels: (force?: boolean) => Promise<void>
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  permissionMode: RuntimePermissionMode
  gitRef: string | null
  loading: boolean
  conversationLoading: boolean
  hasMoreMessagesBefore: boolean
  loadingMoreMessagesBefore: boolean
  refreshing: boolean
  sending: boolean
  running: boolean
  stopping: boolean
  error: string | null
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
  clearError: () => void
}

export interface NewConversationOptions {
  worktreeBranch?: string
  attachmentIds?: number[]
  pursueGoal?: boolean
}
