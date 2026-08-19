# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wait node evaluation: the internal state machine for external events.

The wait node is a DAG node whose status stays ``waiting`` while it listens.
Reruns are an internal state machine (round counter + fresh executions) and
never add graph edges. Terminal events complete the node and let the end node
stop the issue automatically.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.models.delivery import ExternalEventBinding, LoopItem, ProjectAutomationRun
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.issue_workflow import WaitEventRule, WorkflowNodeInstance
from app.services.external_events.adapters import NormalizedExternalEvent
from app.services.external_events.buffer import external_event_buffer
from app.services.external_events.binding import (
    ExternalEventBindingService,
    external_event_binding_service,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_workflow_projection import apply_workflow_nodes

logger = logging.getLogger(__name__)

ACTIVE_EXECUTION_STATUSES = {"pending_approval", "queued", "claimed", "running"}


class ExternalEventEvaluationService:
    def __init__(self, binding_service: ExternalEventBindingService | None = None) -> None:
        self.binding_service = binding_service or external_event_binding_service

    def evaluate_event(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        event: NormalizedExternalEvent,
    ) -> None:
        """Route one inbound event to its wait node."""

        issue, node = self._issue_and_node(db, binding)
        if issue is None or node is None:
            return
        if node.status != "waiting":
            return
        rule = self._matching_rule(node, event.event_type)
        if rule is None:
            return
        if rule.action == "complete":
            self.complete_wait_node(db, issue=issue, node=node, binding=binding)
            return
        self._schedule_rerun(db, binding=binding, node=node, event=event)

    def settle_aggregate(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
    ) -> None:
        """Settle debounce events after the previous rerun execution ends."""

        issue, node = self._issue_and_node(db, binding)
        if issue is None or node is None or node.status != "waiting":
            return
        events = external_event_buffer.take_aggregate(
            task_id=binding.loop_item_id,
            node_id=self._node_id(binding),
        )
        if not events:
            return
        rule = self._matching_rule(node, str(events[0].get("event_type") or ""))
        if rule is None or rule.action != "rerun":
            return
        self._start_rerun(db, binding=binding, node=node, rule=rule, events=events)

    def compensate(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
    ) -> int:
        """Replay events buffered before this binding was registered.

        Returns the number of events replayed so callers can log or test the
        compensation path.
        """

        events = external_event_buffer.take_for_reference(
            binding.provider,
            binding.opaque_ref,
        )
        for event_dict in events:
            event = self._event_from_dict(event_dict)
            if event is not None:
                self.evaluate_event(db, binding=binding, event=event)
        return len(events)

    def complete_wait_node(
        self,
        db: Session,
        *,
        issue: LoopItem,
        node: WorkflowNodeInstance,
        binding: ExternalEventBinding,
    ) -> None:
        """Mark the wait node completed and stop the issue via the end node."""

        raw_workflow = self._raw_workflow(issue)
        nodes = self._mutable_nodes(raw_workflow)
        updated = False
        for candidate in nodes:
            if candidate.get("id") == node.id:
                if candidate.get("status") != "completed":
                    candidate["status"] = "completed"
                    updated = True
                break
        if not updated:
            return
        apply_workflow_nodes(issue, workflow=raw_workflow, nodes=nodes)
        for binding_row in self.binding_service.route(
            db, provider=binding.provider, opaque_ref=binding.opaque_ref
        ):
            if binding_row.loop_item_id == binding.loop_item_id:
                self.binding_service.archive(db, binding_row)
        db.flush()

    def on_execution_terminal(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
    ) -> None:
        """Settle debounce aggregates when the registered task's run ends."""

        if not execution.automation_run_id:
            return
        bindings = self.binding_service.for_execution(
            db,
            loop_item_id=str(execution.loop_item_id or ""),
            automation_run_id=str(execution.automation_run_id),
        )
        for binding in bindings:
            try:
                self.settle_aggregate(db, binding=binding)
            except Exception:
                logger.exception(
                    "External event debounce settle failed binding=%s execution=%s",
                    binding.id,
                    execution.id,
                )

    def _schedule_rerun(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        node: WorkflowNodeInstance,
        event: NormalizedExternalEvent,
    ) -> None:
        if self._has_active_execution(db, binding):
            external_event_buffer.append(
                binding.provider,
                binding.opaque_ref,
                event.event_type,
                self._event_dict(event),
            )
            external_event_buffer.push_aggregate(
                task_id=binding.loop_item_id,
                node_id=self._node_id(binding),
                provider=binding.provider,
                opaque_ref=binding.opaque_ref,
                event_type=event.event_type,
            )
            return
        rule = self._matching_rule(node, event.event_type)
        if rule is None or rule.action != "rerun":
            return
        pending = external_event_buffer.take_aggregate(
            task_id=binding.loop_item_id,
            node_id=self._node_id(binding),
        )
        buffered = external_event_buffer.take(
            binding.provider,
            binding.opaque_ref,
            event.event_type,
        )
        events = self._merge_events(
            [*pending, *buffered, self._event_dict(event)]
        )
        if events:
            self._start_rerun(db, binding=binding, node=node, rule=rule, events=events)

    def _start_rerun(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        node: WorkflowNodeInstance,
        rule: WaitEventRule,
        events: list[dict[str, Any]],
    ) -> None:
        """Start the next repair round for the registered task."""

        run_id = self._metadata(binding).get("automation_run_id")
        if not run_id:
            return
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or run.task_id != binding.loop_item_id:
            logger.warning(
                "External event rerun run mismatch binding=%s run=%s task=%s",
                binding.id,
                run_id,
                binding.loop_item_id,
            )
            return
        item = db.get(LoopItem, binding.loop_item_id)
        if item is None:
            return
        issue_id = self._metadata(binding).get("issue_item_id")
        issue = db.get(LoopItem, issue_id) if issue_id else item
        self._bump_round(db, issue=issue, node=node)
        instruction = self._rerun_instruction(rule, events)
        agent = self._registered_agent(db, run)
        if agent is None:
            return
        self._persist_instruction(db, item, instruction)
        execution = loop_item_execution_service.create_for_assignment(
            db,
            loop_item_id=item.id,
            cloud_project_id=str(item.cloud_project_id),
            agent=agent,
            assigner_user_id=int(run.created_by_user_id or agent.created_by_user_id or 0),
            environment=str(self._agent_env(agent)),
            execution_device_id=self._agent_device(agent),
            priority=item.priority,
            automation_context={
                "rule_id": str(run.parent_id or ""),
                "run_id": str(run.id),
                "trigger": "external_event",
            },
        )
        db.flush()
        if execution.team_id:
            from app.services.board_team_execution import schedule_board_robot_execution

            schedule_board_robot_execution(db, execution)
        logger.info(
            "[ExternalEvent] Rerun queued binding=%s task=%s execution=%s round=%s",
            binding.id,
            item.id,
            execution.id,
            node.wait_round + 1,
        )

    @staticmethod
    def _rerun_instruction(rule: WaitEventRule, events: list[dict[str, Any]]) -> str:
        summaries = [str(event.get("summary") or "") for event in events if event.get("summary")]
        body = "\n".join(f"- {summary}" for summary in summaries) if summaries else ""
        base = (rule.rerun_prompt or "").strip()
        if not body:
            return base
        return f"{base}\n\n外部事件概述：\n{body}" if base else f"外部事件概述：\n{body}"

    @staticmethod
    def _persist_instruction(db: Session, item: LoopItem, instruction: str) -> None:
        metadata = dict(item.metadata_json or {})
        automation = metadata.get("automation")
        automation = dict(automation) if isinstance(automation, dict) else {}
        automation["prompt"] = instruction
        metadata["automation"] = automation
        item.metadata_json = metadata
        item.version += 1
        db.flush()

    @staticmethod
    def _registered_agent(db: Session, run: ProjectAutomationRun):
        from app.models.delivery import ProjectChatAgent

        if run.assignee_agent_id:
            agent = db.get(ProjectChatAgent, run.assignee_agent_id)
            if agent is not None and agent.status == "active":
                return agent
        latest = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.automation_run_id == str(run.id),
                LoopItemExecution.agent_id != "",
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if latest is None:
            return None
        return db.get(ProjectChatAgent, latest.agent_id)

    @staticmethod
    def _agent_env(agent) -> str:
        from app.services.project_chat.service import bot_config

        return str(bot_config(agent).get("execution_environment") or "local")

    @staticmethod
    def _agent_device(agent) -> str | None:
        from app.services.project_chat.service import bot_config

        device = bot_config(agent).get("execution_device_id")
        return device if isinstance(device, str) and device else None

    @staticmethod
    def _has_active_execution(db: Session, binding: ExternalEventBinding) -> bool:
        return (
            db.query(LoopItemExecution.id)
            .filter(
                LoopItemExecution.loop_item_id == binding.loop_item_id,
                LoopItemExecution.automation_run_id
                == str(
                    (
                        binding.metadata_json
                        if isinstance(binding.metadata_json, dict)
                        else {}
                    ).get("automation_run_id")
                    or ""
                ),
                LoopItemExecution.status.in_(ACTIVE_EXECUTION_STATUSES),
            )
            .first()
            is not None
        )

    @staticmethod
    def _bump_round(
        db: Session,
        *,
        issue: LoopItem,
        node: WorkflowNodeInstance,
    ) -> None:
        raw_workflow = (
            issue.metadata_json.get("workflow")
            if isinstance(issue.metadata_json, dict)
            else None
        )
        if not isinstance(raw_workflow, dict):
            return
        nodes = [dict(candidate) for candidate in raw_workflow.get("nodes") or []]
        for candidate in nodes:
            if candidate.get("id") == node.id:
                candidate["wait_round"] = int(candidate.get("wait_round") or 0) + 1
                break
        apply_workflow_nodes(issue, workflow=raw_workflow, nodes=nodes)
        db.flush()

    def _issue_and_node(
        self,
        db: Session,
        binding: ExternalEventBinding,
    ) -> tuple[LoopItem | None, WorkflowNodeInstance | None]:
        metadata = self._metadata(binding)
        issue_id = metadata.get("issue_item_id")
        issue = db.get(LoopItem, issue_id) if issue_id else None
        if issue is None:
            return None, None
        raw_workflow = self._raw_workflow(issue)
        if raw_workflow is None:
            return None, None
        node_id = self._node_id(binding)
        for raw_node in raw_workflow.get("nodes") or []:
            if isinstance(raw_node, dict) and raw_node.get("id") == node_id:
                return issue, WorkflowNodeInstance.model_validate(raw_node)
        return issue, None

    @staticmethod
    def _raw_workflow(issue: LoopItem) -> dict[str, Any] | None:
        metadata = issue.metadata_json if isinstance(issue.metadata_json, dict) else {}
        workflow = metadata.get("workflow")
        return workflow if isinstance(workflow, dict) else None

    @staticmethod
    def _mutable_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
        return [dict(node) for node in workflow.get("nodes") or [] if isinstance(node, dict)]

    @staticmethod
    def _metadata(binding: ExternalEventBinding) -> dict[str, Any]:
        value = binding.metadata_json
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _node_id(binding: ExternalEventBinding) -> str:
        return str(
            (
                binding.metadata_json
                if isinstance(binding.metadata_json, dict)
                else {}
            ).get("workflow_node_id")
            or ""
        )

    @staticmethod
    def _matching_rule(
        node: WorkflowNodeInstance,
        event_type: str,
    ) -> WaitEventRule | None:
        config = node.wait_config
        if config is None:
            return None
        return next(
            (rule for rule in config.rules if rule.event_type == event_type),
            None,
        )

    @staticmethod
    def _event_dict(event: NormalizedExternalEvent) -> dict[str, Any]:
        return {
            "provider": event.provider,
            "opaque_ref": event.opaque_ref,
            "event_type": event.event_type,
            "event_id": event.event_id,
            "summary": event.summary,
            "source_url": event.source_url,
            "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
            "detail": event.detail,
        }

    @staticmethod
    def _event_from_dict(value: dict[str, Any]) -> NormalizedExternalEvent | None:
        provider = str(value.get("provider") or "")
        opaque_ref = str(value.get("opaque_ref") or "")
        event_type = str(value.get("event_type") or "")
        if not provider or not opaque_ref or not event_type:
            return None
        return NormalizedExternalEvent(
            provider=provider,
            opaque_ref=opaque_ref,
            event_type=event_type,
            event_id=(
                str(value["event_id"])
                if value.get("event_id") is not None
                else None
            ),
            summary=str(value.get("summary") or ""),
            source_url=(
                str(value["source_url"]) if value.get("source_url") is not None else None
            ),
            occurred_at=None,
            detail=value.get("detail") if isinstance(value.get("detail"), dict) else {},
        )

    @staticmethod
    def _merge_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for event in events:
            if not isinstance(event, dict) or not event:
                continue
            event_id = str(event.get("event_id") or "")
            identity = (
                ("id", event_id)
                if event_id
                else ("type", f"{event.get('event_type')}:{event.get('summary')}")
            )
            if identity in seen:
                continue
            seen.add(identity)
            merged.append(event)
        return merged


external_event_evaluation_service = ExternalEventEvaluationService()
