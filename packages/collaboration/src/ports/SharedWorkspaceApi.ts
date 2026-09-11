// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationAgent,
  CollaborationAttachment,
  CollaborationBoardSnapshot,
  CollaborationComment,
  CollaborationExecution,
  CollaborationFile,
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
  CollaborationRole,
  CollaborationUser,
} from "../types";

export interface WorkspacePage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface WorkspaceProjectCreateInput {
  projectKey?: string;
  name: string;
  description?: string;
  taskProvider?: "local" | "github" | "gitlab" | "dingtalk_aitable";
  visibility?: "private" | "public";
  providerConfig?: Record<string, unknown>;
}

export interface WorkspaceProjectUpdateInput {
  version: number;
  name?: string;
  description?: string;
  tags?: string[];
  visibility?: "private" | "public";
  providerConfig?: Record<string, unknown>;
  boardConfig?: CollaborationProject["board_config"];
  cardDisplay?: CollaborationProject["card_display"];
  pullRequestAutomation?: Record<string, unknown>;
  workflowDefinition?: Record<string, unknown>;
}

export interface WorkspaceMyWorkItem extends CollaborationIssue {
  project_key: string;
  project_name: string;
  has_active_task: boolean;
  is_unread?: boolean;
}

export interface WorkspaceMessageImportInput {
  sourceTaskId: number;
  subtaskIds?: number[];
  target:
    | { kind: "new_issue"; title: string }
    | { kind: "existing_issue"; issueId: string };
  note?: string;
}

export interface WorkspaceIssueListFilters {
  assigneeType?: "user" | "agent" | "team";
  assigneeId?: string | number;
  executionState?: string;
}

export interface WorkspaceIssuePageInput {
  status: string;
  parentId: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface WorkspaceTaskBinding {
  id: string;
  projectId: string;
  issueId: string | null;
  taskUserId: number;
  deviceId: string;
  taskId: string;
  taskTitle: string | null;
  backendTaskId: number | null;
  modelSelection?: Record<string, unknown> | null;
  workflowNodeId?: string | null;
  bindingType?: "system" | "user";
  linkedAt: string;
}

export interface WorkspaceBoardSnapshot extends CollaborationBoardSnapshot {
  taskBindings: WorkspaceTaskBinding[];
}

export interface WorkspaceIssueCreateInput {
  title: string;
  description?: string;
  status?: string;
  priority?: CollaborationPriority;
  dueAt?: string;
  parentId?: string | null;
  tags?: string[];
  localProjectId?: number | null;
  localProjectName?: string | null;
  workflow?: Record<string, unknown> | null;
  executionConfig?: Record<string, unknown> | null;
  automationRuleId?: string | null;
}

export interface WorkspaceIssueUpdateInput {
  version: number;
  title?: string;
  description?: string;
  status?: string;
  priority?: CollaborationPriority;
  parentId?: string | null;
  assigneeUserId?: number | null;
  assigneeAgentId?: string | null;
  assigneeTeamId?: number | null;
  dueAt?: string | null;
  tags?: string[];
  workflow?: Record<string, unknown> | null;
  executionConfig?: Record<string, unknown> | null;
  automationRuleId?: string | null;
}

export interface WorkspaceIssueAssignmentInput {
  version: number;
  assigneeType: "user" | "agent" | "team";
  assigneeId: string;
  notifyAssignee?: boolean;
}

export interface WorkspaceIssueCollaborator {
  id: string;
  issueId: string;
  userId: number;
  userName: string;
  email: string | null;
  source: string;
  addedByUserId: number;
  createdAt: string;
}

export type WorkspaceWorkflowPlanStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "dispatching"
  | "running"
  | "awaiting_review"
  | "paused"
  | "completed"
  | "failed";

export interface WorkspaceWorkflowPlan {
  runId: string;
  issueId: string;
  stageId: string;
  planVersion: number;
  approvalPolicy: "required" | "automatic";
  status: WorkspaceWorkflowPlanStatus;
  summary: string;
  items: Array<Record<string, unknown>>;
  managerRun?: Record<string, unknown> | null;
}

export interface WorkspaceDeliveryAsset {
  id: string;
  kind: string;
  displayName: string;
  relativePath: string;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
}

export interface WorkspaceDelivery {
  id: string;
  issueId: string;
  status: "draft" | "delivered";
  markdown?: string;
  chat?: Record<string, unknown> | null;
  assets: WorkspaceDeliveryAsset[];
  fulfillments: Array<Record<string, unknown>>;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WorkspaceDeliveryFile {
  assetId: string;
  deliveryId: string;
  issueId: string;
  issueTitle: string;
  relativePath: string;
  displayName: string;
  contentType: string | null;
  sizeBytes: number;
  deliveredAt: string;
  issuePath: Array<{ id: string; title: string }>;
}

export interface WorkspaceBinaryAccess {
  url: string;
  expiresInSeconds: number;
}

export interface WorkspaceAutomationRule {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  version: number;
  [key: string]: unknown;
}

export interface WorkspaceAutomationRun {
  id: string;
  projectId: string;
  automationId: string;
  status: string;
  [key: string]: unknown;
}

export interface WorkspaceIncomingHook {
  id: string;
  projectId: string;
  name: string;
  status: "active" | "disabled";
  version: number;
  [key: string]: unknown;
}

export interface WorkspaceRuntimeProfile {
  id: string;
  name: string;
  executionEnvironment: "local" | "cloud";
  executionDeviceId: string;
  model: string;
  modelType: "public" | "user" | "group" | "runtime" | null;
  modelOptions: Record<string, string>;
  status: "active" | "archived";
  version: number;
  [key: string]: unknown;
}

export interface WorkspaceAutomationExecutionEnvironment {
  deviceId: string;
  label: string;
  executionEnvironment: "local" | "cloud";
}

export interface WorkspaceAutomationModel {
  name: string;
  label: string;
  type: "public" | "user" | "group" | "runtime" | null;
  options: Record<string, string>;
}

export interface WorkspaceAutomationPlugin {
  id: string;
  label: string;
  reference: Record<string, unknown>;
}

export interface WorkspaceAutomationExecutionCatalog {
  environments: WorkspaceAutomationExecutionEnvironment[];
  models: WorkspaceAutomationModel[];
  runtimeProfiles?: WorkspaceRuntimeProfile[];
  plugins: WorkspaceAutomationPlugin[];
}

export interface SharedWorkspaceAutomationExecutionCatalogApi {
  load(projectId: string): Promise<WorkspaceAutomationExecutionCatalog>;
  loadPlugins(
    projectId: string,
    deviceIds: string[],
  ): Promise<WorkspaceAutomationPlugin[]>;
}

export interface WorkspaceProjectAgent extends CollaborationAgent {
  status?: string;
  [key: string]: unknown;
}

export interface SharedWorkspaceProjectsApi {
  list(): Promise<CollaborationProject[]>;
  get(projectId: string): Promise<CollaborationProject>;
  create(input: WorkspaceProjectCreateInput): Promise<CollaborationProject>;
  update(
    projectId: string,
    input: WorkspaceProjectUpdateInput,
  ): Promise<CollaborationProject>;
  archive(projectId: string, version: number): Promise<void>;
  importMessages(
    projectId: string,
    input: WorkspaceMessageImportInput,
  ): Promise<{ issue: CollaborationIssue }>;
}

export interface SharedWorkspaceMyWorkApi {
  list(): Promise<WorkspaceMyWorkItem[]>;
}

export interface SharedWorkspaceIssuesApi {
  list(
    projectId: string,
    filters?: WorkspaceIssueListFilters,
  ): Promise<CollaborationIssue[]>;
  listPage(
    projectId: string,
    input: WorkspaceIssuePageInput,
  ): Promise<
    WorkspacePage<CollaborationIssue> & { taskBindings: WorkspaceTaskBinding[] }
  >;
  getBoardSnapshot(projectId: string): Promise<WorkspaceBoardSnapshot>;
  get(issueId: string): Promise<CollaborationIssue>;
  create(
    projectId: string,
    input: WorkspaceIssueCreateInput,
  ): Promise<CollaborationIssue>;
  update(
    issueId: string,
    input: WorkspaceIssueUpdateInput,
  ): Promise<CollaborationIssue>;
  assign(
    projectId: string,
    issueId: string,
    input: WorkspaceIssueAssignmentInput,
  ): Promise<CollaborationIssue>;
  approveRun(
    projectId: string,
    issueId: string,
    version: number,
  ): Promise<CollaborationIssue>;
  rejectRun(
    projectId: string,
    issueId: string,
    version: number,
    reason?: string,
  ): Promise<CollaborationIssue>;
  archive(issueId: string): Promise<void>;
  reorder(
    projectId: string,
    input: { parentId: string | null; status: string; issueIds: string[] },
  ): Promise<CollaborationIssue[]>;
  markRead(issueId: string): Promise<CollaborationIssue>;
}

export interface SharedWorkspaceCommentsApi {
  list(issueId: string): Promise<CollaborationComment[]>;
  create(issueId: string, body: string): Promise<CollaborationComment>;
}

export interface SharedWorkspaceAttachmentsApi {
  list(issueId: string): Promise<CollaborationAttachment[]>;
  listProjectTaskAttachments(
    projectId: string,
  ): Promise<CollaborationAttachment[]>;
  upload(issueId: string, file: File): Promise<CollaborationAttachment>;
  importContexts(
    issueId: string,
    contextIds: number[],
  ): Promise<CollaborationAttachment[]>;
  access(attachmentId: string): Promise<WorkspaceBinaryAccess>;
  read(attachmentId: string): Promise<Blob>;
  download?(attachmentId: string, filename: string): Promise<void>;
  remove(attachmentId: string): Promise<void>;
}

export interface SharedWorkspaceCollaboratorsApi {
  list(issueId: string): Promise<WorkspaceIssueCollaborator[]>;
  add(issueId: string, userId: number): Promise<WorkspaceIssueCollaborator>;
  remove(issueId: string, userId: number): Promise<void>;
}

export interface SharedWorkspaceTaskBindingsApi {
  list(issueId: string, projectId?: string): Promise<WorkspaceTaskBinding[]>;
}

export interface SharedWorkspaceWorkflowPlansApi {
  get?(issueId: string): Promise<WorkspaceWorkflowPlan | null>;
  approve?(issueId: string): Promise<WorkspaceWorkflowPlan>;
  approveReview?(issueId: string): Promise<WorkspaceWorkflowPlan>;
  pause?(issueId: string): Promise<WorkspaceWorkflowPlan>;
  resume?(issueId: string): Promise<WorkspaceWorkflowPlan>;
  replan?(issueId: string): Promise<WorkspaceWorkflowPlan>;
  decideNode(
    issueId: string,
    workflowNodeId: string,
    action: "approve" | "reject" | "force_advance",
    reason?: string,
  ): Promise<CollaborationIssue>;
  getStageContext(
    issueId: string,
    workflowNodeId: string,
  ): Promise<Record<string, unknown> & { compiledTaskInstruction: string }>;
}

export interface SharedWorkspaceMembersApi {
  list(projectId: string): Promise<CollaborationMember[]>;
  searchUsers(query: string): Promise<CollaborationUser[]>;
  add(
    projectId: string,
    userId: number,
    role?: Exclude<CollaborationRole, "Owner">,
  ): Promise<CollaborationMember>;
  update(
    projectId: string,
    userId: number,
    input: {
      role?: Exclude<CollaborationRole, "Owner">;
      capabilityDescription?: string;
    },
  ): Promise<CollaborationMember>;
  remove(projectId: string, userId: number): Promise<void>;
}

export interface SharedWorkspaceFilesApi {
  list(projectId: string, prefix?: string): Promise<CollaborationFile[]>;
  listDeliveryFiles(projectId: string): Promise<WorkspaceDeliveryFile[]>;
  createFolder(projectId: string, path: string): Promise<CollaborationFile>;
  upload(
    projectId: string,
    file: File,
    path?: string,
  ): Promise<CollaborationFile>;
  access(fileId: string): Promise<WorkspaceBinaryAccess>;
  read(fileId: string): Promise<Blob>;
  move(
    fileId: string,
    path: string,
    version: number,
  ): Promise<CollaborationFile>;
  remove(fileId: string, recursive?: boolean): Promise<void>;
  accessDeliveryFile(assetId: string): Promise<WorkspaceBinaryAccess>;
  readDeliveryFile(assetId: string): Promise<Blob>;
}

export interface SharedWorkspaceDeliveriesApi {
  list(issueId: string): Promise<WorkspaceDelivery[]>;
  get(deliveryId: string): Promise<WorkspaceDelivery>;
  create(
    issueId: string,
    input: {
      markdown: string;
      chat?: Record<string, unknown>;
      sourceTask?: WorkspaceRuntimeTaskAddress;
    },
  ): Promise<WorkspaceDelivery>;
  addAsset(
    deliveryId: string,
    file: File,
    relativePath: string,
  ): Promise<WorkspaceDeliveryAsset>;
  finalize(
    deliveryId: string,
    input: { fulfillments: Array<Record<string, unknown>> },
  ): Promise<WorkspaceDelivery>;
  discardDraft(deliveryId: string): Promise<void>;
}

export interface SharedWorkspaceExecutionsApi {
  list(
    projectId: string,
    filters?: { agentId?: string; status?: string },
  ): Promise<CollaborationExecution[]>;
  stop(
    projectId: string,
    executionId: number,
  ): Promise<{ id: number; status: string }>;
}

export interface SharedWorkspaceAutomationsApi {
  list(projectId: string): Promise<WorkspaceAutomationRule[]>;
  create(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<WorkspaceAutomationRule>;
  migrateWorkflow(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<{ automation: WorkspaceAutomationRule; projectVersion: number }>;
  update(
    projectId: string,
    automationId: string,
    input: Record<string, unknown> & { version: number },
  ): Promise<WorkspaceAutomationRule>;
  remove(
    projectId: string,
    automationId: string,
  ): Promise<{ projectVersion: number; workflowAutomationId: string | null }>;
  runNow(
    projectId: string,
    automationId: string,
  ): Promise<WorkspaceAutomationRun>;
  runWorkflowNode(
    projectId: string,
    issueId: string,
    workflowNodeId: string,
    automationId: string,
  ): Promise<WorkspaceAutomationRun>;
  listRuns(
    projectId: string,
    automationId: string,
  ): Promise<WorkspaceAutomationRun[]>;
  cancelRun(projectId: string, runId: string): Promise<WorkspaceAutomationRun>;
  retryRun(projectId: string, runId: string): Promise<WorkspaceAutomationRun>;
}

export interface SharedWorkspaceIncomingHooksApi {
  catalog(): Promise<Array<Record<string, unknown>>>;
  list(projectId: string): Promise<WorkspaceIncomingHook[]>;
  create(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<WorkspaceIncomingHook>;
  update(
    projectId: string,
    hookId: string,
    input: Record<string, unknown> & { version: number },
  ): Promise<WorkspaceIncomingHook>;
  rotate(projectId: string, hookId: string): Promise<WorkspaceIncomingHook>;
  remove(projectId: string, hookId: string): Promise<void>;
  listEvents(
    projectId: string,
    hookId: string,
    limit?: number,
  ): Promise<Array<Record<string, unknown>>>;
}

export interface SharedWorkspaceRuntimeProfilesApi {
  list(): Promise<WorkspaceRuntimeProfile[]>;
  create(input: Record<string, unknown>): Promise<WorkspaceRuntimeProfile>;
  update(
    profileId: string,
    input: Record<string, unknown> & { version: number },
  ): Promise<WorkspaceRuntimeProfile>;
  remove(profileId: string): Promise<void>;
  getProjectDefault(projectId: string): Promise<{
    projectId: string;
    userId: number;
    runtimeProfileId: string | null;
  }>;
  setProjectDefault(
    projectId: string,
    runtimeProfileId: string,
  ): Promise<{
    projectId: string;
    userId: number;
    runtimeProfileId: string | null;
  }>;
  selectExecution(
    projectId: string,
    executionId: number,
    runtimeProfileId: string,
    version: number,
  ): Promise<CollaborationExecution>;
}

export interface SharedWorkspaceAgentsApi {
  list(projectId: string): Promise<WorkspaceProjectAgent[]>;
  create(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<WorkspaceProjectAgent>;
  update(
    projectId: string,
    agentId: string,
    input: Record<string, unknown>,
  ): Promise<WorkspaceProjectAgent>;
}

/**
 * The one cloud-domain API consumed by the shared workspace UI.
 *
 * Transport envelopes and casing conversion belong in the host adapter.
 * Electron runtime orchestration does not belong here.
 */
export interface SharedWorkspaceApi {
  projects: SharedWorkspaceProjectsApi;
  myWork?: SharedWorkspaceMyWorkApi;
  issues: SharedWorkspaceIssuesApi;
  comments: SharedWorkspaceCommentsApi;
  attachments: SharedWorkspaceAttachmentsApi;
  collaborators: SharedWorkspaceCollaboratorsApi;
  taskBindings: SharedWorkspaceTaskBindingsApi;
  workflowPlans: SharedWorkspaceWorkflowPlansApi;
  members: SharedWorkspaceMembersApi;
  files: SharedWorkspaceFilesApi;
  deliveries: SharedWorkspaceDeliveriesApi;
  executions: SharedWorkspaceExecutionsApi;
  automations: SharedWorkspaceAutomationsApi;
  incomingHooks: SharedWorkspaceIncomingHooksApi;
  automationExecutionCatalog?: SharedWorkspaceAutomationExecutionCatalogApi;
  runtimeProfiles: SharedWorkspaceRuntimeProfilesApi;
  agents: SharedWorkspaceAgentsApi;
}

export interface WorkspaceRuntimeTaskAddress {
  deviceId: string;
  taskId: string;
  backendTaskId?: number | null;
  modelSelection?: Record<string, unknown> | null;
}

/** Wework-only bridge between cloud issues and the local desktop runtime. */
export interface WeworkWorkspaceRuntimePort {
  findIssueForTask(
    task: WorkspaceRuntimeTaskAddress,
  ): Promise<CollaborationIssue>;
  findCloudContextForTask(task: WorkspaceRuntimeTaskAddress): Promise<{
    project: CollaborationProject;
    issueId: string | null;
    workflowNodeId?: string | null;
  }>;
  bindTask(
    issueId: string,
    task: WorkspaceRuntimeTaskAddress,
    taskTitle?: string | null,
    workflowNodeId?: string | null,
  ): Promise<void>;
  unbindTask(issueId: string, task: WorkspaceRuntimeTaskAddress): Promise<void>;
  unbindCloudContext(task: WorkspaceRuntimeTaskAddress): Promise<void>;
  trackProjectTask(
    projectId: string,
    task: WorkspaceRuntimeTaskAddress,
    title: string,
    description: string,
  ): Promise<{ issue: CollaborationIssue }>;
  updateTrackedTaskStatus(
    task: WorkspaceRuntimeTaskAddress,
    executionStatus:
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "archived",
  ): Promise<CollaborationIssue | null>;
  updateTrackedTaskTitle(
    task: WorkspaceRuntimeTaskAddress,
    title: string,
  ): Promise<CollaborationIssue | null>;
  claimNextExecution(input: {
    executionDeviceId: string;
    leaseSeconds: number;
  }): Promise<CollaborationExecution | null>;
  reportExecutionLifecycle(
    projectId: string,
    executionId: number,
    event:
      | {
          type: "heartbeat";
          runtimeDeviceId: string | null;
          runtimeTaskId: string | null;
        }
      | {
          type: "start_requested";
          runtimeDeviceId: string;
          runtimeTaskId: string;
        }
      | {
          type: "dispatch_unknown";
          runtimeDeviceId: string;
          runtimeTaskId: string;
          error: string;
        }
      | {
          type: "runtime_start";
          runtimeDeviceId: string;
          runtimeTaskId: string;
          prompt: string | null;
          model?: string | null;
        }
      | { type: "dispatch_failed"; error: string },
  ): Promise<CollaborationExecution | null>;
}

/** Browser-only integration points. These are effects, not workspace API. */
export interface WebWorkspaceHostPort {
  navigate(path: string): void;
  openExternal(url: string): void;
  notify(message: string, kind: "success" | "error"): void;
  getSourceTaskSelection?(): { taskId: number; subtaskIds?: number[] } | null;
}

/** Cross-host effects used by the shared UI. */
export interface SharedWorkspaceHostPort {
  saveFile(input: { blob: Blob; filename: string }): Promise<void>;
  navigate(location: {
    projectId: string | null;
    issueId: string | null;
    view: string;
  }): void;
  openExternal(url: string): void;
  notify(message: string, kind: "success" | "error"): void;
}
