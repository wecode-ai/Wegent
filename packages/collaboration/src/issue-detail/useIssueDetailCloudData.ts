// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  WorkspaceDelivery,
  WorkspaceIssueCollaborator,
  WorkspaceTaskBinding,
  WorkspaceWorkflowPlan,
} from "../ports/SharedWorkspaceApi";
import type { CollaborationAgent, CollaborationMember } from "../types";

type IssueDetailCloudApi = Pick<
  SharedWorkspaceApi,
  | "members"
  | "agents"
  | "collaborators"
  | "taskBindings"
  | "workflowPlans"
  | "deliveries"
>;

interface IssueDetailCloudData {
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  collaborators: WorkspaceIssueCollaborator[];
  taskBindings: WorkspaceTaskBinding[];
  workflowPlan: WorkspaceWorkflowPlan | null;
  deliveries: WorkspaceDelivery[];
}

const emptyData: IssueDetailCloudData = {
  members: [],
  agents: [],
  collaborators: [],
  taskBindings: [],
  workflowPlan: null,
  deliveries: [],
};

export function useIssueDetailCloudData({
  api,
  issueId,
  projectId,
  onError,
}: {
  api: IssueDetailCloudApi;
  issueId: string;
  projectId: string;
  onError(): void;
}) {
  const [data, setData] = useState<IssueDetailCloudData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [selectedDelivery, setSelectedDelivery] =
    useState<WorkspaceDelivery | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSelectedDelivery(null);

    void Promise.all([
      api.members.list(projectId),
      api.agents.list(projectId),
      api.collaborators.list(issueId),
      api.taskBindings.list(issueId, projectId),
      api.workflowPlans.get?.(issueId) ?? Promise.resolve(null),
      api.deliveries.list(issueId),
    ])
      .then(
        ([
          members,
          agents,
          collaborators,
          taskBindings,
          workflowPlan,
          deliveries,
        ]) => {
          if (!active) return;
          setData({
            members,
            agents: agents.filter((agent) => agent.status !== "archived"),
            collaborators,
            taskBindings,
            workflowPlan,
            deliveries,
          });
        },
      )
      .catch(() => {
        if (active) onError();
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    api.agents,
    api.collaborators,
    api.deliveries,
    api.members,
    api.taskBindings,
    api.workflowPlans,
    issueId,
    onError,
    projectId,
  ]);

  const addCollaborator = useCallback(
    async (userId: number) => {
      try {
        const collaborator = await api.collaborators.add(issueId, userId);
        setData((current) => ({
          ...current,
          collaborators: current.collaborators.some(
            (item) => item.userId === collaborator.userId,
          )
            ? current.collaborators
            : [...current.collaborators, collaborator],
        }));
      } catch {
        onError();
      }
    },
    [api.collaborators, issueId, onError],
  );

  const removeCollaborator = useCallback(
    async (userId: number) => {
      try {
        await api.collaborators.remove(issueId, userId);
        setData((current) => ({
          ...current,
          collaborators: current.collaborators.filter(
            (item) => item.userId !== userId,
          ),
        }));
      } catch {
        onError();
      }
    },
    [api.collaborators, issueId, onError],
  );

  const runWorkflowAction = useCallback(
    async (
      action: "approve" | "approveReview" | "pause" | "resume" | "replan",
    ): Promise<void> => {
      const operation = api.workflowPlans[action];
      if (!operation) return;
      try {
        const workflowPlan = await operation(issueId);
        setData((current) => ({ ...current, workflowPlan }));
      } catch {
        onError();
      }
    },
    [api.workflowPlans, issueId, onError],
  );

  const openDelivery = useCallback(
    async (deliveryId: string) => {
      try {
        setSelectedDelivery(await api.deliveries.get(deliveryId));
      } catch {
        onError();
      }
    },
    [api.deliveries, onError],
  );

  return {
    ...data,
    loading,
    selectedDelivery,
    setSelectedDelivery,
    addCollaborator,
    removeCollaborator,
    runWorkflowAction,
    openDelivery,
  };
}
