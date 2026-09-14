// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  WorkspaceDelivery,
  WorkspaceIssueCollaborator,
  WorkspaceTaskBinding,
  WorkspaceWorkflowPlan,
} from "../ports/SharedWorkspaceApi";
import type { CollaborationMember } from "../types";
import { IssueDetailActivity } from "./IssueDetailCore";
import {
  IssueWorkflowPlanSection,
  workspaceWorkflowPlanView,
} from "./IssueWorkflowPlanSection";

interface Labels {
  collaborators: string;
  addCollaborator: string;
  noCollaborators: string;
  taskBindings: string;
  noTaskBindings: string;
  workflow: string;
  noWorkflow: string;
  approve: string;
  approveReview: string;
  pause: string;
  resume: string;
  replan: string;
  deliveries: string;
  noDeliveries: string;
  close: string;
}

export function IssueDetailCloudSections({
  members,
  collaborators,
  taskBindings,
  workflowPlan,
  deliveries,
  selectedDelivery,
  loading,
  labels,
  onAddCollaborator,
  onRemoveCollaborator,
  onWorkflowAction,
  onOpenDelivery,
  onCloseDelivery,
}: {
  members: CollaborationMember[];
  collaborators: WorkspaceIssueCollaborator[];
  taskBindings: WorkspaceTaskBinding[];
  workflowPlan: WorkspaceWorkflowPlan | null;
  deliveries: WorkspaceDelivery[];
  selectedDelivery: WorkspaceDelivery | null;
  loading: boolean;
  labels: Labels;
  onAddCollaborator(userId: number): Promise<void>;
  onRemoveCollaborator(userId: number): Promise<void>;
  onWorkflowAction(
    action: "approve" | "approveReview" | "pause" | "resume" | "replan",
  ): Promise<void>;
  onOpenDelivery(deliveryId: string): Promise<void>;
  onCloseDelivery(): void;
}) {
  const availableMembers = members.filter(
    (member) =>
      !collaborators.some(
        (collaborator) => collaborator.userId === member.user_id,
      ),
  );

  return (
    <>
      <IssueDetailActivity
        title={labels.collaborators}
        count={collaborators.length}
      >
        <div
          className="shared-issue-detail-cloud-list"
          data-testid="collaboration-issue-collaborators"
        >
          {collaborators.length === 0 ? (
            <p className="shared-issue-detail-attachment-empty">
              {labels.noCollaborators}
            </p>
          ) : (
            collaborators.map((collaborator) => (
              <div
                className="shared-issue-detail-cloud-row"
                key={collaborator.userId}
              >
                <span>{collaborator.userName}</span>
                <button
                  type="button"
                  data-testid={`collaboration-issue-collaborator-remove-${collaborator.userId}`}
                  onClick={() => void onRemoveCollaborator(collaborator.userId)}
                >
                  {labels.close}
                </button>
              </div>
            ))
          )}
        </div>
        <label className="shared-issue-detail-cloud-add">
          {labels.addCollaborator}
          <select
            data-testid="collaboration-issue-collaborator-add"
            defaultValue=""
            disabled={loading || availableMembers.length === 0}
            onChange={(event) => {
              const userId = Number(event.target.value);
              if (userId) void onAddCollaborator(userId);
              event.target.value = "";
            }}
          >
            <option value="">-</option>
            {availableMembers.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.user_name}
              </option>
            ))}
          </select>
        </label>
      </IssueDetailActivity>

      <IssueDetailActivity
        title={labels.taskBindings}
        count={taskBindings.length}
      >
        <div
          className="shared-issue-detail-cloud-list"
          data-testid="collaboration-issue-task-bindings"
        >
          {taskBindings.length === 0 ? (
            <p className="shared-issue-detail-attachment-empty">
              {labels.noTaskBindings}
            </p>
          ) : (
            taskBindings.map((binding) => (
              <div className="shared-issue-detail-cloud-row" key={binding.id}>
                <strong>{binding.taskTitle || binding.taskId}</strong>
                <span>{binding.deviceId}</span>
              </div>
            ))
          )}
        </div>
      </IssueDetailActivity>

      <IssueDetailActivity title={labels.workflow}>
        <div data-testid="collaboration-issue-workflow-plan">
          {!workflowPlan ? (
            <p className="shared-issue-detail-attachment-empty">
              {labels.noWorkflow}
            </p>
          ) : (
            <IssueWorkflowPlanSection
              plan={workspaceWorkflowPlanView(workflowPlan)}
              labels={{
                title: labels.workflow,
                status: {
                  idle: "idle",
                  planning: "planning",
                  awaiting_approval: "awaiting approval",
                  dispatching: "dispatching",
                  running: "running",
                  awaiting_review: "awaiting review",
                  paused: "paused",
                  completed: "completed",
                  failed: "failed",
                },
                failed: "failed",
                retry: labels.replan,
                replan: labels.replan,
                approve: labels.approve,
                approveReview: labels.approveReview,
                resume: labels.resume,
                pause: labels.pause,
                rerun: labels.replan,
                manager: "Workflow manager",
                managerEnteringQueue: "Entering queue",
                openExecution: "Open execution",
                outcomePassed: "Passed",
                outcomeNeedsRework: "Needs rework",
                taskPendingCreation: "Pending",
                openTask: "Open task",
                error: {
                  timeout: "Workflow timed out",
                  offline: "Executor is offline",
                  assignee: "Assignee is unavailable",
                  model: "Model is unavailable",
                  generic: "Workflow failed",
                },
              }}
              availableActions={{
                approve: Boolean(workflowPlan && onWorkflowAction),
                approveReview: Boolean(workflowPlan && onWorkflowAction),
                pause: Boolean(workflowPlan && onWorkflowAction),
                resume: Boolean(workflowPlan && onWorkflowAction),
                replan: Boolean(workflowPlan && onWorkflowAction),
              }}
              testIds={{
                plan: "collaboration-issue-workflow-plan-panel",
                approve: "collaboration-issue-workflow-approve",
                approveReview: "collaboration-issue-workflow-approve-review",
                pause: "collaboration-issue-workflow-pause",
                resume: "collaboration-issue-workflow-resume",
                replan: "collaboration-issue-workflow-replan",
              }}
              onAction={onWorkflowAction}
            />
          )}
        </div>
      </IssueDetailActivity>

      <IssueDetailActivity title={labels.deliveries} count={deliveries.length}>
        <div
          className="shared-issue-detail-cloud-list"
          data-testid="collaboration-issue-deliveries"
        >
          {deliveries.length === 0 ? (
            <p className="shared-issue-detail-attachment-empty">
              {labels.noDeliveries}
            </p>
          ) : (
            deliveries.map((delivery) => (
              <button
                type="button"
                className="shared-issue-detail-delivery"
                data-testid={`collaboration-issue-delivery-${delivery.id}`}
                key={delivery.id}
                onClick={() => void onOpenDelivery(delivery.id)}
              >
                <span>{delivery.markdown || delivery.id}</span>
                <span>{delivery.status}</span>
              </button>
            ))
          )}
        </div>
        {selectedDelivery ? (
          <article
            className="shared-issue-detail-delivery-detail"
            data-testid="collaboration-issue-delivery-detail"
          >
            <header>
              <strong>
                {selectedDelivery.markdown || selectedDelivery.id}
              </strong>
              <button type="button" onClick={onCloseDelivery}>
                {labels.close}
              </button>
            </header>
            {selectedDelivery.assets.length > 0 ? (
              <ul>
                {selectedDelivery.assets.map((asset) => (
                  <li key={asset.id}>
                    {asset.displayName} · {asset.relativePath}
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        ) : null}
      </IssueDetailActivity>
    </>
  );
}
