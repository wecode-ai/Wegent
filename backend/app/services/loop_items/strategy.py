# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Readable strategy revisions, admission, and deterministic coordinator checks."""

import re
from datetime import datetime, timezone
from difflib import unified_diff
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.cloud_project import CloudProject
from app.models.delivery import (
    Delivery,
    LoopItem,
    LoopItemComment,
    LoopNode,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.kind import Kind
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.collaboration_strategy import (
    COORDINATOR_EVIDENCE_LIMIT,
    CollaborationStrategyPublish,
    CollaborationStrategyRevision,
    CoordinatorDecision,
    IntakeDefinition,
)
from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    ProjectWorkflowDefinition,
    WorkflowAction,
    WorkflowNodeDefinition,
    WorkflowNodeInstance,
    instantiate_workflow,
)
from app.schemas.project_chat import ProjectChatMention
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.strategy_coordinator import (
    comment_evidence_refs,
    coordinator_check,
    refresh_strategy_coordinator,
    validate_coordinator_decision,
)
from shared.telemetry.decorators import trace_sync

STAGES = (
    (
        "requirement_intake",
        "需求提出",
        "product",
        (
            ("objective", "目标"),
            ("scope", "范围"),
            ("non_goals", "非目标"),
            ("acceptance_criteria", "验收标准"),
        ),
    ),
    (
        "joint_review",
        "共同评审",
        "product",
        (
            ("review_conclusions", "评审结论"),
            ("risks", "风险"),
            ("schedule", "排期"),
            ("owners", "责任人"),
        ),
    ),
    (
        "development_preparation",
        "开发准备",
        "development",
        (
            ("design", "设计稿"),
            ("technical_spec", "技术方案"),
            ("test_cases", "测试方案或用例"),
            ("questions_closed", "未决问题关闭记录"),
        ),
    ),
    (
        "development_implementation",
        "开发实现",
        "development",
        (
            ("code_or_pr", "代码快照或 PR"),
            ("testable_version", "可测试版本"),
            ("self_tests", "自测与联调结果"),
        ),
    ),
    (
        "quality_acceptance",
        "质量验收",
        "qa",
        (
            ("qa_report", "测试报告"),
            ("business_acceptance", "业务验收结论"),
            ("visual_acceptance", "视觉验收结论"),
            ("problem_closure_or_accepted_risk", "问题闭环或授权接受的遗留风险"),
        ),
    ),
    (
        "release_launch",
        "发布上线",
        "development",
        (
            ("release_authorization", "发布授权"),
            ("release_record", "发布记录"),
            ("online_verification", "线上验证"),
            ("rollback", "回滚准备"),
            ("retrospective", "复盘结论"),
        ),
    ),
)
ROLE_LABELS = {
    "产品": "product",
    "研发": "development",
    "UI": "design",
    "设计": "design",
    "测试": "qa",
    "QA": "qa",
    "PMO": "pmo",
}
STAGE_LABELS = {stage[0]: stage[1] for stage in STAGES}
STATUS_BY_STAGE = {
    "requirement_intake": "pending",
    "joint_review": "pending",
    "development_preparation": "pending",
    "development_implementation": "in_progress",
    "quality_acceptance": "in_review",
    "release_launch": "in_review",
}
INTAKE_LABELS = {
    "objective": "目标",
    "scope": "范围",
    "non_goals": "非目标",
    "acceptance_criteria": "验收标准",
    "dependencies": "依赖说明",
    "proposed_owner": "拟负责人",
    "description": "需求描述",
    "priority": "优先级",
}
STAGE_OWNER_ALIASES = {
    "requirement_intake": {"requirement_intake", "product", "需求提出"},
    "joint_review": {"joint_review", "review", "product", "共同评审"},
    "development_preparation": {
        "development_preparation",
        "preparation",
        "development",
        "开发准备",
    },
    "development_implementation": {
        "development_implementation",
        "implementation",
        "development",
        "开发实现",
    },
    "quality_acceptance": {
        "quality_acceptance",
        "acceptance",
        "qa",
        "测试",
        "质量验收",
    },
    "release_launch": {"release_launch", "release", "development", "发布上线"},
}
EVENT_LABELS = {
    "exit_inbox": "已离开收集箱",
    "strategy_applied": "已应用项目策略",
    "stage_started": "阶段开始",
    "stage_completed": "阶段完成",
    "stage_reworked": "已退回",
    "stage_forced": "强制推进",
    "stage_waiting": "进入等待",
    "stage_blocked": "遇到阻塞",
    "stage_ready": "恢复处理",
    "strategy_upgraded": "策略已升级",
    "clarification_requested": "需要人工澄清",
    "stage_review_recorded": "阶段评审已记录",
    "quality_handoff": "质量验收已交接",
    "quality_blocked": "质量验收有阻塞",
    "release_recorded": "发布记录已保存",
    "release_failed": "发布记录为失败",
    "change_request_lower_bound": "PR 已建立开发实现下限",
    "change_request_checks_failed": "PR 检查失败",
    "change_request_conflict": "PR 发生冲突",
    "change_request_quality_ready": "PR 已满足质量准入",
    "change_request_merged": "必要 PR 已全部合并",
    "quality_rework": "质量验收退回修复",
}


def strategy_enabled(project: CloudProject) -> bool:
    return bool(
        settings.COLLAB_AGENTIC_STRATEGY_V1
        and (project.metadata_json or {}).get("collaboration_strategy")
    )


def _resolve_member(db: Session, project: CloudProject, username: str) -> User:
    user = db.query(User).filter(User.user_name == username).first()
    if user is None or user.id not in project_participant_ids(db, project):
        raise HTTPException(
            422,
            {
                "code": "strategy_member_unavailable",
                "username": username,
                "message": "Strategy roles must name current project participants",
            },
        )
    return user


def _roles_from_text(db: Session, project: CloudProject, text: str) -> dict:
    roles = {role: [] for role in set(ROLE_LABELS.values())}
    for line in text.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        label, members = (cells[0], cells[1]) if len(cells) >= 2 else ("", "")
        if label not in ROLE_LABELS:
            match = re.match(
                r"^\s*[-*]\s*(产品|研发|UI|设计|测试|QA|PMO)\s*[:：]\s*(.*)$", line
            )
            if not match:
                continue
            label, members = match.groups()
            members = members.split("，", 1)[0].split("；", 1)[0]
        names = re.findall(r"[A-Za-z][A-Za-z0-9_-]*", members)
        for name in names:
            _resolve_member(db, project, name)
            if name not in roles[ROLE_LABELS[label]]:
                roles[ROLE_LABELS[label]].append(name)
    missing = [role for role, names in roles.items() if not names]
    if missing:
        raise HTTPException(
            422,
            {
                "code": "strategy_roles_missing",
                "missing_roles": missing,
                "message": "Include product, development, UI, QA and PMO members in the readable role table or role bullets",
            },
        )
    return roles


def _resolve_stage_assistant(
    db: Session,
    project: CloudProject,
    stage_id: str,
    allowed_user_names: list[str],
) -> tuple[str, str, str] | None:
    """Resolve an enabled W-0056 roster owner for one strategy stage."""
    if stage_id in {"requirement_intake", "release_launch"}:
        return None
    allowed_users = (
        db.query(User).filter(User.user_name.in_(allowed_user_names)).all()
        if allowed_user_names
        else []
    )
    allowed_ids = {user.id for user in allowed_users}
    if not allowed_ids:
        return None
    aliases = {
        value.casefold() for value in STAGE_OWNER_ALIASES.get(stage_id, {stage_id})
    }
    rows = db.execute(
        select(
            LoopNode.id,
            LoopNode.user_id,
            LoopNode.metadata_json,
        )
        .where(
            LoopNode.cloud_project_id == str(project.id),
            LoopNode.resource_type == "project_assistant_roster",
            LoopNode.user_id.in_(allowed_ids),
            LoopNode.status == "active",
            loop_datetime_is_unset(LoopNode.deleted_at),
        )
        .order_by(LoopNode.id)
    ).all()
    for row in rows:
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        role_id = str(metadata.get("role_id") or "").strip().casefold()
        capability_tags = {
            str(value).strip().casefold()
            for value in metadata.get("capability_tags", [])
            if str(value).strip()
        }
        if role_id not in aliases and not aliases.intersection(capability_tags):
            continue
        endpoint_ref = str(metadata.get("endpoint_ref") or "")
        endpoint_kind = str(metadata.get("endpoint_kind") or "")
        owner_id = str(row.user_id or "")
        if endpoint_kind == "wegent_agent":
            parts = endpoint_ref.split(":")
            if (
                len(parts) != 4
                or parts[0] != "wegent_agent"
                or parts[1] != owner_id
                or parts[-1] != str(metadata.get("role_id") or "")
            ):
                continue
            agent = db.get(ProjectChatAgent, parts[2])
            if (
                agent is None
                or agent.cloud_project_id != str(project.id)
                or agent.status != "active"
            ):
                continue
            return "agent", agent.id, str(metadata.get("display_name") or agent.name)
        if endpoint_kind in {"local_wework", "cloud_device"} and owner_id:
            if (
                len(endpoint_ref.split(":")) != 3
                or endpoint_ref.split(":")[1] != owner_id
                or endpoint_ref.split(":")[-1] != str(metadata.get("role_id") or "")
            ):
                continue
            owner = db.get(User, int(owner_id))
            if owner is not None:
                return (
                    "user",
                    owner_id,
                    str(metadata.get("display_name") or f"{owner.user_name} 的助理"),
                )
    return None


def _workflow_owner_label(db: Session, node: WorkflowNodeInstance | None) -> str | None:
    if node is None or not node.required_assignee_id:
        return None
    if node.required_assignee_type == "user":
        user = db.get(User, int(node.required_assignee_id))
        if user is None:
            return None
        return (
            f"{user.user_name} 的助理"
            if node.execution_mode == "robot"
            else user.user_name
        )
    if node.required_assignee_type == "agent":
        agent = db.get(ProjectChatAgent, node.required_assignee_id)
        return agent.title or agent.name if agent is not None else None
    if node.required_assignee_type == "team":
        team = db.get(Kind, int(node.required_assignee_id))
        return team.name if team is not None else None
    return None


@trace_sync("collaboration_strategy.publish", tracer_name="backend")
def publish_strategy(
    db: Session,
    project: CloudProject,
    user_id: int,
    values: CollaborationStrategyPublish,
    metadata: dict,
) -> None:
    if not settings.COLLAB_AGENTIC_STRATEGY_V1:
        raise HTTPException(409, "Agentic collaboration strategy is disabled")
    current = metadata.get("collaboration_strategy") or {}
    if current.get("version", 0) != values.expected_version:
        raise HTTPException(409, {"code": "strategy_version_conflict"})
    roles = _roles_from_text(db, project, values.text)
    revision = CollaborationStrategyRevision(
        version=values.expected_version + 1,
        text=values.text,
        diff="\n".join(
            unified_diff(
                current.get("text", "").splitlines(),
                values.text.splitlines(),
                fromfile=f"v{values.expected_version}",
                tofile=f"v{values.expected_version + 1}",
                lineterm="",
            )
        ),
        published_at=datetime.now(timezone.utc),
        published_by=user_id,
        role_mapping=roles,
    ).model_dump(mode="json")
    metadata["collaboration_strategy"] = revision
    metadata["collaboration_strategy_versions"] = [
        *metadata.get("collaboration_strategy_versions", []),
        revision,
    ]
    metadata["workflow_definition"] = compile_strategy(
        db, project, revision
    ).model_dump(mode="json")
    board = dict(metadata.get("board_config") or {})
    from app.schemas.cloud_project import default_board_statuses

    old_statuses = board.get("statuses") or [
        status.model_dump() for status in default_board_statuses()
    ]
    statuses = [status.model_dump() for status in default_board_statuses()]
    # Historical lanes stay available when an existing Issue still uses them.
    active_statuses = {
        row[0]
        for row in db.query(LoopItem.status)
        .filter(LoopItem.cloud_project_id == project.id)
        .distinct()
    }
    known = {entry["id"] for entry in statuses}
    statuses.extend(
        entry for entry in old_statuses if entry.get("id") in active_statuses - known
    )
    board["statuses"] = statuses
    board["processing_start_status_id"] = "pending"
    metadata["board_config"] = board
    metadata["tags"] = list(
        dict.fromkeys([*metadata.get("tags", []), *STAGE_LABELS.values()])
    )


def compile_strategy(
    db: Session, project: CloudProject, revision: dict
) -> ProjectWorkflowDefinition:
    nodes = []
    for index, (key, label, role, requirements) in enumerate(STAGES):
        names = revision["role_mapping"].get(role, [])
        assistant = _resolve_stage_assistant(db, project, key, names)
        if assistant is not None:
            assignee_type, assignee_id, _ = assistant
            execution_mode = "robot"
        else:
            owner = _resolve_member(db, project, names[0]) if names else None
            assignee_type = "user" if owner else None
            assignee_id = str(owner.id) if owner else None
            execution_mode = "human"
        nodes.append(
            WorkflowNodeDefinition(
                id=key,
                name=label,
                functional_role=role,
                depends_on=[STAGES[index - 1][0]] if index else [],
                execution_mode=execution_mode,
                required_assignee_type=assignee_type,
                required_assignee_id=assignee_id,
                human_approval_required=execution_mode == "human",
                rework_to=(
                    "development_implementation"
                    if key == "quality_acceptance"
                    else None
                ),
                required_deliverables=[
                    {
                        "id": requirement,
                        "name": name,
                        "value_type": (
                            "code_snapshot" if requirement == "code_or_pr" else "text"
                        ),
                        "accepted_value_types": (
                            ["pull_request"]
                            if requirement == "code_or_pr"
                            else ["file", "url"]
                        ),
                    }
                    for requirement, name in requirements
                ],
            )
        )
    return ProjectWorkflowDefinition(
        version=revision["version"],
        stage_mode="dag",
        nodes=nodes,
        approval_policy="required",
        advancement_policy="manual",
    )


def inbox_snapshot(revision: dict) -> IssueWorkflowInstance:
    return IssueWorkflowInstance(
        instance_id=str(uuid4()), strategy_snapshot=revision, strategy_state="inbox"
    )


def intake_missing(item: LoopItem) -> list[str]:
    intake = IntakeDefinition.model_validate(
        (item.metadata_json or {}).get("intake_definition") or {}
    )
    missing = [key for key, value in intake.model_dump().items() if not value.strip()]
    if not item.description.strip():
        missing.append("description")
    if item.priority == "none":
        missing.append("priority")
    return missing


def require_stage_actor(
    db: Session,
    item: LoopItem,
    user_id: int,
    workflow: IssueWorkflowInstance,
    node_id: str,
) -> None:
    access = require_cloud_project_role(
        db, int(item.cloud_project_id), user_id, BaseRole.Developer
    )
    if node_id == "release_launch" and not has_permission(
        access.role, BaseRole.Maintainer
    ):
        raise HTTPException(403, "Release confirmation requires a project maintainer")
    if has_permission(access.role, BaseRole.Maintainer):
        return
    role = next(stage[2] for stage in STAGES if stage[0] == node_id)
    names = workflow.strategy_snapshot.role_mapping.get(role, [])
    # Quality acceptance is shared by product, design, QA and development.
    if node_id in {"joint_review", "development_preparation", "quality_acceptance"}:
        names = [
            name
            for key in ("product", "design", "qa", "development")
            for name in workflow.strategy_snapshot.role_mapping.get(key, [])
        ]
    user = db.get(User, user_id)
    node = next(node for node in workflow.nodes if node.id == node_id)
    if (
        node.required_assignee_type == "user"
        and str(user_id) == node.required_assignee_id
    ):
        return
    if user is None or user.user_name not in names:
        raise HTTPException(
            403,
            {
                "code": "strategy_stage_permission_denied",
                "current_stage_id": node_id,
                "message": "Current stage requires an authorized functional participant",
            },
        )


def require_deliverable_actor(
    db: Session,
    item: LoopItem,
    user_id: int,
    workflow: IssueWorkflowInstance,
    fulfillments: list,
) -> None:
    access = require_cloud_project_role(
        db, int(item.cloud_project_id), user_id, BaseRole.Developer
    )
    if has_permission(access.role, BaseRole.Maintainer):
        return
    roles = {
        "design": ["design"],
        "technical_spec": ["development"],
        "test_cases": ["qa"],
        "questions_closed": ["product", "development"],
        "qa_report": ["qa"],
        "business_acceptance": ["product"],
        "visual_acceptance": ["design"],
        "problem_closure_or_accepted_risk": ["product", "development"],
    }
    username = db.get(User, user_id).user_name
    for value in fulfillments:
        required = roles.get(value.requirement_id)
        if required and not any(
            username in workflow.strategy_snapshot.role_mapping.get(role, [])
            for role in required
        ):
            raise HTTPException(
                403,
                {
                    "code": "strategy_deliverable_permission_denied",
                    "requirement_id": value.requirement_id,
                    "message": "This evidence requires its responsible functional participant",
                },
            )


def notify_strategy_event(
    db: Session,
    item: LoopItem,
    user_id: int,
    workflow: IssueWorkflowInstance,
    event: str,
    reason: str = "",
    *,
    changed_stage: str | None = None,
    skipped_stages: list[str] | None = None,
) -> None:
    """Append the shared tracking message and real mentions in one transaction."""
    from app.services.loop_items.workflow import missing_deliverables
    from app.services.project_chat.mention_notification import (
        _authorized_mention_target,
        notify_project_chat_mentions,
    )
    from app.services.wework_notifications import create_notification

    project = db.get(CloudProject, item.cloud_project_id)
    names = workflow.strategy_snapshot.role_mapping.get("pmo", [])
    if not names:
        raise HTTPException(
            409,
            {
                "code": "pmo_unavailable",
                "message": "Configure an authorized PMO participant in the strategy text",
            },
        )
    recipients = [_resolve_member(db, project, name) for name in names]
    for recipient in recipients:
        _authorized_mention_target(db, project, item.id, item, recipient.id)
    current = next(
        (node for node in workflow.nodes if node.id == workflow.current_stage_id), None
    )
    missing = missing_deliverables(db, item, current) if current else []
    inbox = workflow.strategy_state == "inbox"
    intake = (item.metadata_json or {}).get("intake_definition") or {}
    summary = {
        "event": event,
        "event_label": EVENT_LABELS[event],
        "changed_stage": changed_stage,
        "skipped_stages": skipped_stages or [],
        "strategy_version": workflow.strategy_snapshot.version,
        "status": item.status,
        "stage": (
            current.name
            if current
            else ("收集箱" if workflow.strategy_state == "inbox" else "已完成")
        ),
        "owner": (
            _workflow_owner_label(db, current)
            if current
            else intake.get("proposed_owner") if inbox else None
        ),
        "blockers": (
            [entry["name"] for entry in missing]
            if current
            else [INTAKE_LABELS[key] for key in intake_missing(item)] if inbox else []
        ),
        "next_action": (
            "补齐阶段证据并请求有权限的人确认"
            if current
            else "完善收集箱准入信息" if inbox else "流程已完成"
        ),
        "required_evidence": (
            [entry.name for entry in current.required_deliverables]
            if current
            else list(INTAKE_LABELS.values()) if inbox else []
        ),
        "reason": reason,
    }
    message_id = str(uuid4())
    mentions = [
        ProjectChatMention(type="user", id=str(user.id), label=user.user_name)
        for user in recipients
    ]
    content = "\n".join(
        [
            f"协作策略 v{workflow.strategy_snapshot.version} · {EVENT_LABELS[event]}"
            + (f"：{changed_stage}" if changed_stage else ""),
            f"状态：{summary['status']}；阶段：{summary['stage']}；负责人：{summary['owner'] or '—'}",
            *([f"跳过阶段：{'、'.join(skipped_stages)}"] if skipped_stages else []),
            f"阻塞：{'、'.join(summary['blockers']) or '无'}",
            f"下一动作：{summary['next_action']}",
            f"所需证据：{'、'.join(summary['required_evidence']) or '无'}",
            f"依据：{reason or '服务端门禁校验'}",
        ]
    )
    actor = db.get(User, user_id)
    db.add(
        ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(project.id),
            task_id=item.id,
            sender_type="system",
            sender_id=str(user_id),
            sender_name=actor.user_name,
            message_type="text",
            content=content,
            status="completed",
            metadata_json={
                "mentions": [value.model_dump() for value in mentions],
                "workflow_summary": summary,
                "execution_dispatch": "comment_only",
                "event_type": "collaboration_strategy",
                "actor_user_id": user_id,
            },
        )
    )
    db.info.setdefault("strategy_summary_message_ids", []).append(message_id)
    notify_project_chat_mentions(
        db,
        project=project,
        task_id=item.id,
        item=item,
        comment_id=message_id,
        actor_user_id=user_id,
        actor_name=actor.user_name,
        content=content,
        mentions=mentions,
    )
    # The generic chat path suppresses self mentions; PMO tracking includes self.
    if any(user.id == user_id for user in recipients):
        create_notification(
            db,
            user_id=user_id,
            actor_user_id=user_id,
            title="项目阶段追踪",
            body=content,
            kind="mention",
            project_id=str(project.id),
            item_id=item.id,
            comment_id=message_id,
            payload={"workflow_summary": summary},
        )
    workflow.notification_state = {
        "status": "notified",
        "comment_id": message_id,
        "recipient_ids": [user.id for user in recipients],
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }


def push_strategy_summaries(db: Session) -> None:
    from app.services.project_chat.push import push_project_chat_message
    from app.services.project_chat.service import project_chat_service

    for message_id in db.info.pop("strategy_summary_message_ids", []):
        row = db.query(ProjectChatMessage).filter_by(message_id=message_id).one()
        push_project_chat_message(
            project_chat_service.to_view(row, db=db).model_dump(
                mode="json", by_alias=True
            )
        )


@sqlalchemy_event.listens_for(Session, "after_rollback")
def discard_strategy_summary_pushes(db: Session) -> None:
    db.info.pop("strategy_summary_message_ids", None)


def synchronize_strategy_stage(item: LoopItem, workflow: IssueWorkflowInstance) -> None:
    if workflow.strategy_state not in {"inbox", "active"}:
        return
    if workflow.strategy_state == "inbox":
        item.status = "inbox"
    else:
        successful_release = any(
            isinstance(record, dict) and record.get("successful") is True
            for record in workflow.release_records
        )
        item.status = STATUS_BY_STAGE.get(
            workflow.current_stage_id or "",
            "completed" if successful_release else "in_review",
        )
    metadata = dict(item.metadata_json or {})
    metadata["tags"] = [
        tag for tag in metadata.get("tags", []) if tag not in STAGE_LABELS.values()
    ]
    if workflow.current_stage_id:
        metadata["tags"].append(STAGE_LABELS[workflow.current_stage_id])
    item.metadata_json = metadata


def apply_strategy_action(
    db: Session,
    item: LoopItem,
    user_id: int,
    workflow: IssueWorkflowInstance | None,
    action: WorkflowAction,
    *,
    actor_is_human: bool,
) -> tuple[IssueWorkflowInstance, list]:
    from app.services.loop_items.workflow import COMPLETED, require_ready_node

    project = db.get(CloudProject, item.cloud_project_id)
    if action.type == "admit" and workflow is None:
        if not strategy_enabled(project):
            raise HTTPException(409, "Publish an enabled collaboration strategy first")
        workflow = inbox_snapshot(
            (project.metadata_json or {})["collaboration_strategy"]
        )
    if workflow is None or workflow.strategy_snapshot is None:
        raise HTTPException(409, "This Issue has no strategy snapshot")
    if (
        action.type
        in {"admit", "evaluate", "record_coordinator_decision", "upgrade_strategy"}
        and not settings.COLLAB_AGENTIC_STRATEGY_V1
    ):
        raise HTTPException(409, "Agentic collaboration strategy is disabled")
    activated = []
    if action.type == "record_stage_review":
        from app.services.loop_items.strategy_reviews import record_stage_review

        record_stage_review(
            db,
            item,
            user_id,
            workflow,
            action,
            actor_is_human=actor_is_human,
        )
    elif action.type == "record_release":
        from app.services.loop_items.strategy_reviews import record_release

        record_release(
            db,
            item,
            user_id,
            workflow,
            action,
            actor_is_human=actor_is_human,
        )
    elif action.type == "admit":
        if not actor_is_human:
            raise HTTPException(403, "Admission requires authorized human confirmation")
        if workflow.strategy_state != "inbox" or item.status != "inbox":
            raise HTTPException(409, "Only inbox Issues can be admitted")
        missing = intake_missing(item)
        if missing:
            raise HTTPException(
                409,
                {
                    "code": "intake_incomplete",
                    "current_stage_id": "inbox",
                    "missing_conditions": missing,
                },
            )
        intake = IntakeDefinition.model_validate(
            item.metadata_json["intake_definition"]
        )
        owner = _resolve_member(db, project, intake.proposed_owner.strip())
        require_cloud_project_role(db, int(project.id), owner.id, BaseRole.Developer)
        compiled = instantiate_workflow(
            compile_strategy(
                db, project, workflow.strategy_snapshot.model_dump(mode="json")
            )
        )
        compiled.strategy_snapshot = workflow.strategy_snapshot
        compiled.instance_id = workflow.instance_id
        compiled.strategy_state = "active"
        compiled.nodes[0].required_assignee_id = str(owner.id)
        workflow = compiled
        activated = [node for node in workflow.nodes if node.status == "ready"]
        notify_strategy_event(db, item, user_id, workflow, "exit_inbox", action.reason)
    elif action.type == "upgrade_strategy":
        require_cloud_project_role(db, int(project.id), user_id, BaseRole.Maintainer)
        if not actor_is_human:
            raise HTTPException(403, "Strategy upgrade requires human confirmation")
        revision = (project.metadata_json or {}).get("collaboration_strategy")
        if not revision or revision["version"] <= workflow.strategy_snapshot.version:
            raise HTTPException(409, "This Issue already uses the current strategy")
        # Recompile validates new participants while retaining all historical attempts.
        definition = compile_strategy(db, project, revision)
        if workflow.strategy_state == "active" and [
            node.id for node in workflow.nodes
        ] != [node.id for node in definition.nodes]:
            raise HTTPException(409, "This running strategy cannot be safely migrated")
        old = workflow.strategy_snapshot
        workflow.strategy_snapshot = CollaborationStrategyRevision.model_validate(
            revision
        )
        workflow.strategy_upgrade_history.append(
            {
                "from_version": old.version,
                "to_version": revision["version"],
                "actor_user_id": user_id,
                "reason": action.reason,
                "upgraded_at": datetime.now(timezone.utc).isoformat(),
                "migration_impact": {
                    "preserved_stage_ids": [node.id for node in workflow.nodes],
                    "preserved_evidence": True,
                    "role_mapping_changed": old.role_mapping
                    != revision["role_mapping"],
                    "previous_role_mapping": old.role_mapping,
                    "new_role_mapping": revision["role_mapping"],
                    "assignment_changes": [
                        {
                            "stage_id": node.id,
                            "from_user_id": node.required_assignee_id,
                            "to_user_id": updated.required_assignee_id,
                        }
                        for node, updated in zip(workflow.nodes, definition.nodes)
                        if node.status not in COMPLETED
                        and node.required_assignee_id != updated.required_assignee_id
                    ],
                },
            }
        )
        for node, updated in zip(workflow.nodes, definition.nodes):
            if node.status in COMPLETED:
                continue
            node.required_assignee_id = updated.required_assignee_id
            if node.id == workflow.current_stage_id:
                activated = [node]
        notify_strategy_event(
            db, item, user_id, workflow, "strategy_upgraded", action.reason
        )
    elif action.type == "set_stage_state":
        if not actor_is_human:
            raise HTTPException(403, "Stage state requires human confirmation")
        if workflow.current_stage_id != action.node_id:
            raise HTTPException(409, "Only the current stage can change its state")
        require_stage_actor(db, item, user_id, workflow, action.node_id)
        node = next(node for node in workflow.nodes if node.id == action.node_id)
        if action.state == "ready":
            previous = node.status
            node.status = "ready"
            try:
                require_ready_node(workflow, node.id)
            finally:
                node.status = previous
        if node.status == action.state:
            raise HTTPException(409, "Stage already has this state")
        node.state_history.append(
            {
                "from": node.status,
                "to": action.state,
                "at": datetime.now(timezone.utc).isoformat(),
                "actor_user_id": user_id,
                "reason": action.reason,
            }
        )
        node.status = action.state
        notify_strategy_event(
            db, item, user_id, workflow, f"stage_{action.state}", action.reason
        )
    else:
        if workflow.current_stage_id:
            require_stage_actor(db, item, user_id, workflow, workflow.current_stage_id)
        if action.type == "evaluate":
            workflow.coordinator_decision = coordinator_check(
                db, item, workflow, action
            )
        else:
            validate_coordinator_decision(db, item, workflow, action.decision)
            if action.decision.idempotency_key != action.idempotency_key:
                raise HTTPException(
                    422, "Coordinator and action idempotency keys must match"
                )
            workflow.coordinator_decision = action.decision
        if workflow.coordinator_decision.clarification:
            notify_strategy_event(
                db,
                item,
                user_id,
                workflow,
                "clarification_requested",
                workflow.coordinator_decision.clarification,
            )
    workflow.version += 1
    synchronize_strategy_stage(item, workflow)
    return workflow, activated


def require_strategy_update(db: Session, item: LoopItem, values) -> None:
    """Keep ordinary status/tag/assignment edits from bypassing admission."""
    from app.services.loop_items.workflow import workflow_snapshot

    workflow = workflow_snapshot(item)
    if workflow is None or workflow.strategy_snapshot is None:
        return
    if values.status is not None and values.status != item.status:
        raise HTTPException(
            409,
            {
                "code": "strategy_transition_required",
                "current_stage_id": workflow.current_stage_id or "inbox",
                "message": "Use the authorized strategy action to change stages",
            },
        )
    if values.tags is not None:
        expected = (
            {STAGE_LABELS[workflow.current_stage_id]}
            if workflow.current_stage_id
            else set()
        )
        if set(values.tags) & set(STAGE_LABELS.values()) != expected:
            raise HTTPException(
                409, "Stage labels are maintained by strategy decisions"
            )
    assignee_fields = {
        "assignee_user_id",
        "assignee_agent_id",
        "assignee_team_id",
        "assignee_group_id",
    }
    if assignee_fields & values.model_fields_set:
        current = next(
            (node for node in workflow.nodes if node.id == workflow.current_stage_id),
            None,
        )
        if current is None or workflow.strategy_state != "active":
            raise HTTPException(409, "Only the active strategy stage can be reassigned")
        requested = [
            (
                field.removeprefix("assignee_").removesuffix("_id"),
                getattr(values, field),
            )
            for field in assignee_fields & values.model_fields_set
            if getattr(values, field) is not None
        ]
        if len(requested) != 1:
            raise HTTPException(
                409, "A strategy stage must keep one configured assignee"
            )
        target_type, target_value = requested[0]
        if target_type not in {"user", "agent", "team"}:
            raise HTTPException(409, "Collaboration groups cannot own a strategy stage")
        target_id = str(target_value)
        if (
            current.required_assignee_type != target_type
            or current.required_assignee_id != target_id
        ):
            raise HTTPException(
                409,
                {
                    "code": "strategy_stage_assignee_mismatch",
                    "current_stage_id": current.id,
                    "message": "Use the stage assignee configured by the strategy snapshot",
                },
            )
        if current.id == "requirement_intake" and target_type == "user":
            user = db.get(User, int(target_id))
            product_names = workflow.strategy_snapshot.role_mapping.get("product", [])
            if user is None or user.user_name not in product_names:
                raise HTTPException(
                    409,
                    {
                        "code": "requirement_intake_owner_conflict",
                        "current_stage_id": current.id,
                        "message": "Requirement intake must stay with the product role",
                    },
                )
    if values.automation_rule_id:
        raise HTTPException(
            409,
            "Strategy stages use their configured assignee instead of a separate automation rule",
        )
    if values.intake_definition is not None and workflow.strategy_state != "inbox":
        raise HTTPException(
            409,
            "Admitted intake definition is immutable; use evidence and explicit strategy upgrade",
        )
