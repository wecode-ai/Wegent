# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Attribute a task-bound knowledge search from the persisted task origin."""


def task_query_surface(task_json: dict, client_origin: str | None) -> str | None:
    if not isinstance(task_json, dict):
        return None
    metadata = task_json.get("metadata")
    labels = metadata.get("labels") if isinstance(metadata, dict) else None
    if not isinstance(labels, dict) or labels.get("source") != "chat_shell":
        return None
    if str(labels.get("is_api_call", "")).lower() == "true":
        return "external_api"
    if client_origin == "frontend":
        if labels.get("taskType") == "knowledge":
            return "knowledge_web"
        if labels.get("taskType") == "chat":
            return "chat_shell"
    return None
