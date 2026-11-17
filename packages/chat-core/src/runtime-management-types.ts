import type { RuntimeName, RuntimeTaskAddress } from "./runtime";
import type {
  RuntimeProjectSpaceRef,
  RuntimeProjectAiSettings,
} from "./runtime-task-api-types";

export interface RuntimeLocalProjectUpsertRequest {
  deviceId: string;
  projectKey: string;
  name: string;
  roots: string[];
  defaultProjectSpace?: RuntimeProjectSpaceRef | null;
  aiSettings?: RuntimeProjectAiSettings | null;
  runtime: "codex";
}

export interface RuntimeLocalProjectUpsertResponse {
  accepted: boolean;
  deviceId: string;
  projectKey: string;
  name: string;
  roots: string[];
  defaultProjectSpace?: RuntimeProjectSpaceRef | null;
  aiSettings?: RuntimeProjectAiSettings | null;
  runtime: "codex";
  error?: string | null;
}

export interface RuntimeWorkspaceRenameRequest {
  deviceId: string;
  projectKey?: string | null;
  workspacePath: string;
  runtime: RuntimeName;
  name: string;
}

export interface RuntimeWorkspaceRemoveRequest {
  deviceId: string;
  projectKey?: string | null;
  workspacePath: string;
  runtime: RuntimeName;
}

export interface RuntimeProjectPinRequest {
  deviceId: string;
  projectKey: string;
  pinned: boolean;
  beforeProjectKey?: string | null;
}

export interface ArchivedConversationsListRequest {
  deviceId?: string | null;
  workspacePath?: string | null;
  projectId?: number | null;
  runtimeProjectKey?: string | null;
  search?: string | null;
  source?: "all" | "local" | "cloud";
  sort?: "updated" | "created" | "alphabetical";
}

export interface ArchivedConversationItem {
  id: string;
  taskId: string;
  threadId?: string | null;
  title: string;
  projectId?: number | null;
  projectKey?: string | null;
  projectName?: string | null;
  workspacePath: string;
  workspaceKind?: "workspace" | "worktree" | "chat" | string | null;
  runtimeHandle?: Record<string, unknown> | null;
  deviceId: string;
  deviceName?: string | null;
  deviceAddress?: string | null;
  source: "local" | "cloud";
  runtime?: RuntimeName | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
}

export interface ArchivedConversationProjectGroup {
  projectId?: number | null;
  projectKey?: string | null;
  projectName: string;
  count: number;
}

export interface ArchivedConversationsListResponse {
  items: ArchivedConversationItem[];
  projectGroups: ArchivedConversationProjectGroup[];
  total: number;
}

export interface RuntimeTaskArchiveRequest extends RuntimeTaskAddress {
  cleanupWorktree?: boolean;
}
