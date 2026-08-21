# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Assignee projection for materialized workflow plan items."""

from app.models.delivery import ProjectWorkflowPlanItem


def workflow_plan_assignee_payload(
    item: ProjectWorkflowPlanItem,
) -> dict[str, object]:
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    assignee_type = str(metadata.get("assignee_type") or "")
    assignee_id = str(metadata.get("assignee_id") or "")
    if assignee_type == "user":
        return {"assignee_user_id": int(assignee_id)}
    if assignee_type == "agent":
        return {"assignee_agent_id": assignee_id}
    if assignee_type == "team":
        return {"assignee_team_id": int(assignee_id)}
    raise ValueError("Workflow plan item has no valid assignee")
