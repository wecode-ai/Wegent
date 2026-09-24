export type IssueDispatchTargetKind = "human" | "agent" | "collaboration_group";

export type IssueDispatchStatus = "active" | "completed" | "cancelled";

export type IssueDispatchTaskStatus =
  | "assigned"
  | "queued"
  | "running"
  | "submitted"
  | "failed"
  | "needs_rework"
  | "cancelled";

export interface IssueDispatchTarget {
  kind: IssueDispatchTargetKind;
  id: string;
  name: string;
}

export interface IssueDispatchCandidate extends IssueDispatchTarget {
  description?: string | null;
}

export interface IssueDispatchOutcome {
  id: string;
  dispatchId: string;
  roundId: string;
  taskId: string;
  status: "passed" | "needs_rework" | "failed" | "cancelled";
  summary: string;
  evidence: Array<Record<string, unknown>>;
  createdAt: string;
}

export interface IssueDispatchTask {
  id: string;
  dispatchId: string;
  roundId: string;
  issueId: string;
  title: string;
  instruction: string;
  target: IssueDispatchTarget;
  workflowStageId: string | null;
  workflowStageName: string | null;
  executionLocation?: "local" | "cloud" | null;
  status: IssueDispatchTaskStatus;
  outcome: IssueDispatchOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export type IssueDispatchRoundStatus =
  | "planning"
  | "executing"
  | "evaluating"
  | "closed"
  | "cancelled";

export interface IssueDispatchRound {
  id: string;
  dispatchId: string;
  sequence: number;
  status: IssueDispatchRoundStatus;
  tasks: IssueDispatchTask[];
  createdAt: string;
  completedAt: string | null;
}

export interface IssueDispatch {
  id: string;
  projectId: string;
  issueId: string;
  target: IssueDispatchTarget;
  leaderType?: "human" | "agent" | null;
  leaderId?: string | null;
  leaderName?: string | null;
  status: IssueDispatchStatus;
  rounds: IssueDispatchRound[];
  managerTurnCount?: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateIssueDispatchInput {
  target: Pick<IssueDispatchTarget, "kind" | "id">;
  taskTitle: string;
  instructions: string;
}

export interface CreateIssueDispatchRoundInput {
  tasks: Array<{
    title: string;
    instruction: string;
    target: Pick<IssueDispatchTarget, "kind" | "id">;
    workflowStageId?: string | null;
  }>;
}

export interface SharedWorkspaceDispatchesApi {
  list(issueId: string): Promise<IssueDispatch[]>;
  get(dispatchId: string): Promise<IssueDispatch>;
  listCandidates(
    issueId: string,
    targetKind: IssueDispatchTargetKind,
  ): Promise<IssueDispatchCandidate[]>;
  create(
    issueId: string,
    input: CreateIssueDispatchInput,
  ): Promise<IssueDispatch>;
  createRound(
    dispatchId: string,
    input: CreateIssueDispatchRoundInput,
  ): Promise<IssueDispatch>;
  cancelTask(taskId: string): Promise<IssueDispatch>;
  retry(dispatchId: string): Promise<IssueDispatch>;
  decide(
    dispatchId: string,
    input: { status: "in_review" | "completed"; reason: string },
  ): Promise<IssueDispatch>;
  returnForRework(dispatchId: string): Promise<IssueDispatch>;
}
