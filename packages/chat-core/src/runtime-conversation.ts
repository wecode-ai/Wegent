import type {
  Attachment,
  CodexMemoryCitation,
  CodexReference,
  TurnFileChangesSummary,
} from "./runtime";
import type { CodeCommentContext } from "./code-comment";
import type {
  BaseWorkbenchProcessingBlock,
  WorkbenchMessage as CoreWorkbenchMessage,
  WorkbenchMessageRole,
  WorkbenchMessageStatus,
  WorkbenchFileChangesBlock,
  WorkbenchPlanBlock,
  WorkbenchProcessingBlock,
  WorkbenchSubagentBlock,
  WorkbenchThinkingBlock,
  WorkbenchTextBlock,
  WorkbenchToolBlock,
  WorkbenchToolBlockStatus,
} from "./workbench-message-reducer";

export type MessageRole = WorkbenchMessageRole;
export type MessageStatus = WorkbenchMessageStatus;

export type ToolBlockStatus = WorkbenchToolBlockStatus;

export type BaseProcessingBlock = BaseWorkbenchProcessingBlock;

export type ToolBlock = WorkbenchToolBlock;

export type ThinkingBlock = WorkbenchThinkingBlock;

export type TextBlock = WorkbenchTextBlock;

export type PlanBlock = WorkbenchPlanBlock;

export type SubagentBlock = WorkbenchSubagentBlock<TurnFileChangesSummary>;

export type FileChangesBlock =
  WorkbenchFileChangesBlock<TurnFileChangesSummary>;

export type ProcessingBlock = WorkbenchProcessingBlock<TurnFileChangesSummary>;

export type MessageSource = NonNullable<CoreWorkbenchMessage["source"]>;

export type RuntimeWorkbenchMessageStatus =
  | WorkbenchMessageStatus
  | "cancelled";

export type RuntimeSubagentStatusState = "running" | "done" | "interrupted";

export interface RuntimeSubagentStatus {
  id: string;
  agentId: string;
  agentPath: string;
  agentName: string;
  status: RuntimeSubagentStatusState;
  kind?: string;
  updatedAtMs?: number | null;
}

export type WorkbenchMessage = Omit<
  CoreWorkbenchMessage<Attachment, TurnFileChangesSummary>,
  "blocks"
> & {
  blocks?: ProcessingBlock[];
  runtimeDisplayItems?: RuntimeAssistantDisplayItem[];
  runtimeMessageIndex?: number | null;
  turnId?: string | null;
  runtimeTurnStartedAt?: number;
  runtimeStatus?: RuntimeWorkbenchMessageStatus | null;
  completedAt?: string | number | null;
  stoppedNotice?: boolean | null;
  runtimeGoalRequest?: boolean | null;
  runtimeGuidance?: boolean | null;
  runtimeGuidanceSplitBefore?: boolean | null;
  runtimeGuidanceContinuation?: boolean | null;
  codeComments?: CodeCommentContext[] | null;
  references?: CodexReference[] | null;
  memoryCitations?: CodexMemoryCitation[] | null;
};

export type RuntimeAssistantDisplayItem =
  | {
      id: string;
      type: "assistant_text";
      content: string;
    }
  | {
      id: string;
      type: "block";
    };

export interface RuntimeConversationTurn {
  id: string | null;
  clientUserMessageId?: string;
  runtimeMessageIndex?: number;
  itemMerge?: "prepend";
  items: RuntimeConversationItem[];
  status: RuntimeWorkbenchMessageStatus;
  startedAt?: number;
  completedAt?: string | number | null;
  error?: string;
  errorType?: string;
  stoppedNotice?: boolean | null;
  contentTruncated?: boolean;
  streamingThinkingContent?: string;
  fileChanges?: TurnFileChangesSummary;
  references?: CodexReference[];
  memoryCitations?: CodexMemoryCitation[];
}

export type RuntimeConversationItem =
  | {
      id: string;
      type: "user_message";
      message: WorkbenchMessage & { role: "user" };
    }
  | {
      id: string;
      type: "assistant_text";
      content: string;
      streamTextOffset?: number;
      createdAt: string;
    }
  | {
      id: string;
      type: "block";
      block: ProcessingBlock;
    };

export type RuntimePaneMessageAction =
  import("./workbench-message-reducer").WorkbenchMessageAction<
    import("./runtime").Attachment,
    import("./runtime").TurnFileChangesSummary
  >;
