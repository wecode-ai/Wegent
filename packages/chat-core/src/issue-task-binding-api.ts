import type { RuntimeTaskAddress } from "./runtime";

interface BindingHttpClient {
  post<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string, body?: unknown): Promise<T>;
}

/** The binding is persisted before a comment execution can emit its first event. */
export function createIssueTaskBindingApi(client: BindingHttpClient) {
  return {
    bindTask(
      itemId: string,
      task: RuntimeTaskAddress,
      taskTitle?: string | null,
      workflowNodeId?: string | null,
      dispatch?: {
        humanAssignmentId: string;
        dispatchId: string;
        dispatchRoundId: string;
        assignmentId: string;
      } | null,
    ): Promise<void> {
      const modelSelection =
        task.runtimeHandle?.modelSelection ??
        task.runtimeHandle?.model_selection;
      const executionContext = {
        runtime: task.runtime,
        threadId: task.threadId,
        workspacePath: task.workspacePath,
        workspaceKind: task.workspaceKind,
        worktreeId: task.worktreeId,
      };
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`, {
        ...task,
        ...(taskTitle ? { taskTitle } : {}),
        ...(workflowNodeId ? { workflowNodeId } : {}),
        ...(dispatch ?? {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(Object.values(executionContext).some(
          (value) => value != null && value !== "",
        )
          ? { executionContext }
          : {}),
      });
    },
    unbindTask(itemId: string, task: RuntimeTaskAddress): Promise<void> {
      return client.delete(
        `/v1/loop-items/${encodeURIComponent(itemId)}/tasks`,
        task,
      );
    },
  };
}
