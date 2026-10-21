// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import type { CollaborationOwnedAgent, CollaborationProject } from "../types";
import type { SharedIssueDetailPort } from "./createSharedIssueDetailPort";

export function useIssueAssigneeResources(
  port: SharedIssueDetailPort,
  project: CollaborationProject | undefined,
  onError: (message: string) => void,
  assignedAgentId?: string | null,
) {
  const [catalog, setCatalog] = useState<{
    port: SharedIssueDetailPort;
    key: string;
    resources: CollaborationOwnedAgent[];
  }>();
  const {
    id,
    workspace_id,
    project_store,
    access_role,
    workspace_access_role,
  } = project ?? {};
  const key = JSON.stringify({
    id,
    workspace_id,
    project_store,
    access_role,
    workspace_access_role,
    assignedAgentId,
  });
  useEffect(() => {
    if (!id || !project_store || !port.agentResources) return;
    let active = true;
    void port.agentResources
      .list({
        id,
        workspace_id,
        project_store,
        access_role,
        workspace_access_role,
      })
      .then(
        (items) => {
          if (active) setCatalog({ port, key, resources: items });
        },
        (cause) => {
          if (active) {
            setCatalog({ port, key, resources: [] });
            onError(cause instanceof Error ? cause.message : String(cause));
          }
        },
      );
    return () => {
      active = false;
    };
  }, [
    port,
    key,
    id,
    workspace_id,
    project_store,
    access_role,
    workspace_access_role,
    onError,
    assignedAgentId,
  ]);
  return catalog?.port === port && catalog.key === key ? catalog.resources : [];
}
