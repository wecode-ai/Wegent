import type { SharedWorkflowNode } from "./workflowTypes";

const CURRENT_STAGE_STATUS_PRIORITY: SharedWorkflowNode["status"][] = [
  "running",
  "awaiting_approval",
  "awaiting_deliverables",
  "changes_requested",
  "failed",
  "queued",
  "ready",
];

export function getCurrentWorkflowNode(
  nodes: SharedWorkflowNode[],
): SharedWorkflowNode | null {
  for (const status of CURRENT_STAGE_STATUS_PRIORITY) {
    const currentNode = nodes.find((node) => node.status === status);
    if (currentNode) return currentNode;
  }

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node && isWorkflowNodeCompleted(node.status)) return node;
  }
  return nodes[0] ?? null;
}

export function workflowNodeStatusLabel(
  t: (key: string) => string,
  status: SharedWorkflowNode["status"],
): string {
  if (status === "blocked") return t("todo.workflow_node_blocked");
  if (status === "ready") return t("todo.workflow_node_ready");
  if (status === "waiting") return t("todo.workflow_node_waiting");
  if (status === "reacting") return t("todo.workflow_node_reacting");
  if (status === "queued") return t("todo.workflow_node_queued");
  if (status === "running") return t("todo.workflow_node_running");
  if (status === "awaiting_approval")
    return t("todo.workflow_node_awaiting_approval");
  if (status === "awaiting_deliverables")
    return t("todo.workflow_node_awaiting_deliverables");
  if (status === "changes_requested")
    return t("todo.workflow_node_changes_requested");
  if (status === "completed") return t("todo.workflow_node_completed");
  if (status === "forced_completed")
    return t("todo.workflow_node_forced_completed");
  return t("todo.workflow_node_failed");
}

export function isWorkflowNodeCompleted(
  status: SharedWorkflowNode["status"],
): boolean {
  return status === "completed" || status === "forced_completed";
}
