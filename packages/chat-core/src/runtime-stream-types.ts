import type {
  RuntimeContextUsage,
  TurnFileChangesSummary,
  ChatBlock,
} from "./runtime";
import type { ModelType } from "./models";
export interface RuntimeGoal {
  threadId: string;
  objective: string;
  status: RuntimeGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeGoalContinuationPayload {
  taskId?: string;
  subtaskId?: string;
  deviceId?: string;
  threadId?: string;
  turnId?: string;
  status: RuntimeGoalContinuationStatus;
}

export interface RuntimeSupervisorState {
  mode: RuntimeSupervisorMode;
  status: RuntimeSupervisorStatus;
  instructions: string;
  modelSelection?: ModelSelectionConfig | null;
  intervalSeconds?: number;
  lastEvaluatedAt?: number | null;
  lastError?: string | null;
  suggestions: RuntimeSupervisorSuggestion[];
}

export interface RuntimeTaskTitleUpdatedPayload {
  taskId?: string;
  subtaskId?: string;
  deviceId?: string;
  title: string;
}

export interface ChatChunkPayload {
  taskId?: string;
  subtaskId?: string;
  itemId?: string;
  content: string;
  contentMode?: "delta" | "snapshot";
  offset?: number;
  result?: ChatResultPayload;
  deviceId?: string;
}

export interface ChatDonePayload {
  taskId?: string;
  subtaskId?: string;
  offset?: number;
  result: ChatResultPayload;
  deviceId?: string;
}

export interface ChatErrorPayload {
  taskId?: string;
  subtaskId?: string;
  error: string;
  type?: string;
  deviceId?: string;
  shellType?: string;
  startedAt?: number;
  durationMs?: number;
}

export interface ChatStartPayload {
  taskId?: string;
  subtaskId?: string;
  clientUserMessageId?: string;
  runtimeGeneratedUserMessage?: {
    id: string;
    message: string;
    createdAt: number;
    source: Record<string, unknown>;
  };
  bot_name?: string;
  shellType?: string;
  deviceId?: string;
}

export interface ChatBlockCreatedPayload {
  taskId?: string;
  subtaskId?: string;
  block: ChatBlock;
  deviceId?: string;
  replacesItemId?: string;
}

export interface ChatBlockUpdatedPayload {
  taskId?: string;
  subtaskId?: string;
  blockId: string;
  content?: string;
  contentDelta?: string;
  toolOutput?: unknown;
  toolOutputDelta?: string;
  toolOutputTruncated?: boolean;
  toolOutputOriginalBytes?: number;
  tool_output_truncated?: boolean;
  tool_output_original_bytes?: number;
  toolInput?: Record<string, unknown>;
  renderPayload?: unknown;
  fileChanges?: TurnFileChangesSummary;
  output?: string;
  summary?: string;
  parentToolUseId?: string;
  agentStatus?: "running" | "done" | "interrupted";
  status?: ChatBlock["status"] | "running";
  completedAt?: number;
  durationMs?: number;
  deviceId?: string;
}

export interface RuntimeGoalEventPayload {
  taskId?: string;
  subtaskId?: string;
  deviceId?: string;
  threadId?: string;
  turnId?: string;
  goal?: RuntimeGoal | null;
}

export interface RuntimePlanEventPayload {
  taskId?: string;
  subtaskId?: string;
  deviceId?: string;
  threadId?: string;
  turnId?: string;
  explanation?: string;
  plan: RuntimePlanStep[];
}

export interface RuntimeGuidanceAppliedPayload {
  taskId?: string;
  subtaskId?: string;
  deviceId?: string;
  guidanceId: string;
  clientGuidanceId?: string;
  message: string;
  appliedAtMs: number;
}

export interface RuntimeSubagentActivityPayload {
  taskId?: string;
  subtaskId?: string;
  deviceId?: string;
  agentPath: string;
  agentId?: string;
  agentName?: string;
  agentThreadId?: string;
  kind?: string;
  status?: string;
  occurredAtMs?: number;
}

export interface RuntimeSupervisorEventPayload {
  deviceId?: string;
  taskId?: string;
  supervisor: RuntimeSupervisorState | null;
}

export type RuntimeGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type RuntimeGoalContinuationStatus = "started" | "settled";

export type RuntimeSupervisorMode = "suggest" | "auto";

export type RuntimeSupervisorStatus =
  | "active"
  | "checking"
  | "error"
  | "disabled";

export interface ModelSelectionConfig {
  modelName: string;
  modelType?: ModelType | null;
  options?: Record<string, string>;
}

export interface RuntimeSupervisorSuggestion {
  id: string;
  message: string;
  rationale: string;
  status: RuntimeSupervisorSuggestionStatus;
  createdAt: number;
  resolvedAt?: number | null;
  sourceTurnId?: string | null;
}

export type ChatResultPayload = Record<string, unknown> & {
  startedAt?: number;
  started_at?: number;
  value?: string;
  itemId?: string;
  item_id?: string;
  error?: string;
  reasoningChunk?: string;
  blocks?: ChatBlock[];
  fileChanges?: TurnFileChangesSummary;
  contextUsage?: RuntimeContextUsage;
};

export interface RuntimePlanStep {
  step: string;
  status: RuntimePlanStepStatus;
}

export type RuntimeSupervisorSuggestionStatus =
  | "pending"
  | "accepted"
  | "dismissed";

export type RuntimePlanStepStatus = "pending" | "inProgress" | "completed";
export interface ChatStreamScope {
  deviceId?: string;
  taskId?: string;
}

export interface RuntimeTransportReplacedPayload {
  previousRuntimeInstanceId: string;
  runtimeInstanceId: string;
}

export interface RuntimeEventLaggedPayload {
  skipped: number;
}

export interface RuntimeWorkChangedPayload {
  deviceId?: string;
  taskId: string;
}

export interface ProjectTaskAssignedPayload {
  projectId: string;
  projectName: string;
  itemId: string;
  itemTitle: string;
  assignerName: string;
}
export interface ChatStreamHandlers {
  scope?: ChatStreamScope;
  onChatStart?: (payload: ChatStartPayload) => void;
  onChatChunk?: (payload: ChatChunkPayload) => void;
  onChatDone?: (payload: ChatDonePayload) => void;
  onChatError?: (payload: ChatErrorPayload) => void;
  onBlockCreated?: (payload: ChatBlockCreatedPayload) => void;
  onBlockUpdated?: (payload: ChatBlockUpdatedPayload) => void;
  onSubagentActivity?: (payload: RuntimeSubagentActivityPayload) => void;
  onRuntimeTaskTitleUpdated?: (payload: RuntimeTaskTitleUpdatedPayload) => void;
  onRuntimeWorkChanged?: (payload: RuntimeWorkChangedPayload) => void;
  onRuntimeGoalUpdated?: (payload: RuntimeGoalEventPayload) => void;
  onRuntimeGoalCleared?: (payload: RuntimeGoalEventPayload) => void;
  onRuntimeSupervisorUpdated?: (payload: RuntimeSupervisorEventPayload) => void;
  onRuntimeGoalContinuation?: (payload: RuntimeGoalContinuationPayload) => void;
  onRuntimePlanUpdated?: (payload: RuntimePlanEventPayload) => void;
  onGuidanceApplied?: (payload: RuntimeGuidanceAppliedPayload) => void;
  onRuntimeEventLagged?: (payload: RuntimeEventLaggedPayload) => void;
  onRuntimeTransportReplaced?: (
    payload: RuntimeTransportReplacedPayload,
  ) => void;
  onWeworkNotification?: () => void;
  onProjectTaskAssigned?: (payload: ProjectTaskAssignedPayload) => void;
}
