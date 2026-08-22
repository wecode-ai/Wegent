# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wait node evaluation: the internal state machine for external events.

The wait node is a DAG node whose status stays ``waiting`` while it listens.
Repair rounds are an internal state machine (round counter + fresh executions
or continue messages) and never add graph edges. Terminal events complete the
node, and the Issue enters review once every required stage completes.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import ExternalEventBinding, LoopItem, ProjectAutomationRun
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.issue_workflow import WaitEventRule, WorkflowNodeInstance
from app.schemas.runtime_work import (
    RuntimeModelSelection,
    RuntimeSendRequest,
    RuntimeTaskAddress,
)
from app.services.external_events.adapters import (
    NormalizedExternalEvent,
    event_type_policy,
    external_event_dict,
)
from app.services.external_events.binding import (
    ExternalEventBindingService,
    external_event_binding_service,
)
from app.services.external_events.buffer import external_event_buffer, merge_events
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_workflow_projection import apply_workflow_nodes

logger = logging.getLogger(__name__)

ACTIVE_EXECUTION_STATUSES = {"pending_approval", "queued", "claimed", "running"}


class ExternalEventEvaluationService:
    def __init__(
        self, binding_service: ExternalEventBindingService | None = None
    ) -> None:
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
        rule = self._matching_rule(node, event.provider, event.event_type)
        if rule is None:
            return
        if rule.action == "complete":
            self.complete_wait_node(db, issue=issue, node=node, binding=binding)
            return
        self._schedule_repair_round(db, binding=binding, node=node, event=event)

    def settle_aggregate(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
    ) -> None:
        """Settle buffered events after the previous rerun execution ends.

        Parked events are drained per (provider, event_type) using the delivery
        policy declared by each event type: merge policies fire one round with
        every event of the first type still waiting; immediate policies fire
        one event per round, serially. Other event types stay parked until the
        round they started has ended.
        """

        issue, node = self._issue_and_node(db, binding)
        if issue is None or node is None or node.status != "waiting":
            return
        first = external_event_buffer.peek_aggregate(
            task_id=binding.loop_item_id,
            node_id=self._node_id(binding),
        )
        if first is None:
            return
        rule = self._matching_rule(node, first[0], first[1])
        if rule is None or rule.action not in {"rerun", "continue"}:
            return
        events = external_event_buffer.take_aggregate(
            task_id=binding.loop_item_id,
            node_id=self._node_id(binding),
        )
        if not events:
            return
        group, rest = self._split_event_groups(events)
        policy = event_type_policy(
            str(group[0].get("provider") or ""),
            str(group[0].get("event_type") or ""),
        )
        if policy is not None and policy.merge_while_running:
            self._park_events(binding=binding, events=rest)
            self._start_repair_round(
                db, binding=binding, node=node, rule=rule, events=group
            )
            return
        fired, *remainder = group
        self._park_events(binding=binding, events=[*remainder, *rest])
        self._start_repair_round(
            db, binding=binding, node=node, rule=rule, events=[fired]
        )

    def settle_window(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        event_type: str,
        generation: int,
    ) -> None:
        """Settle a short-window aggregation when its window expires."""

        issue, node = self._issue_and_node(db, binding)
        if issue is None or node is None or node.status != "waiting":
            return
        rule = self._matching_rule(node, binding.provider, event_type)
        if rule is None or rule.action not in {"rerun", "continue"}:
            return
        events = external_event_buffer.take_window(
            task_id=binding.loop_item_id,
            node_id=self._node_id(binding),
            event_type=event_type,
            generation=generation,
        )
        if not events:
            return
        if self._has_active_execution(db, binding):
            # A repair round started while the window was open; park the
            # window events so they settle together when that round ends.
            self._park_events(binding=binding, events=events)
            return
        self._start_repair_round(
            db, binding=binding, node=node, rule=rule, events=events
        )

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
        """Mark the wait node completed and release the Issue toward review."""

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
        """Settle parked events when the registered task's run ends."""

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
                    "External event aggregate settle failed binding=%s execution=%s",
                    binding.id,
                    execution.id,
                )

    def _schedule_repair_round(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        node: WorkflowNodeInstance,
        event: NormalizedExternalEvent,
    ) -> None:
        rule = self._matching_rule(node, event.provider, event.event_type)
        if rule is None or rule.action not in {"rerun", "continue"}:
            return
        if self._has_active_execution(db, binding):
            self._park_event(binding=binding, event=event)
            return
        policy = event_type_policy(event.provider, event.event_type)
        if policy is not None and policy.window_seconds:
            self._schedule_window(
                db,
                binding=binding,
                node=node,
                event=event,
                window_seconds=policy.window_seconds,
            )
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
        events = merge_events([*pending, *buffered, external_event_dict(event)])
        if not events:
            return
        group, rest = self._split_event_groups(events)
        if policy is not None and policy.merge_while_running:
            self._park_events(binding=binding, events=rest)
            self._start_repair_round(
                db, binding=binding, node=node, rule=rule, events=group
            )
            return
        # Immediate policy: fire rounds one by one. Settle the oldest event of
        # the first type now and park everything else so the following settles
        # fire them serially without merging events into one round.
        fired, *remainder = group
        self._park_events(binding=binding, events=[*remainder, *rest])
        self._start_repair_round(
            db, binding=binding, node=node, rule=rule, events=[fired]
        )

    def _start_repair_round(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        node: WorkflowNodeInstance,
        rule: WaitEventRule,
        events: list[dict[str, Any]],
    ) -> None:
        """Start one repair round with the action the rule declares."""

        if rule.action == "continue":
            self._start_continue(
                db, binding=binding, node=node, rule=rule, events=events
            )
            return
        self._start_rerun(db, binding=binding, node=node, rule=rule, events=events)

    def _start_continue(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        node: WorkflowNodeInstance,
        rule: WaitEventRule,
        events: list[dict[str, Any]],
    ) -> None:
        """Queue one continue round for the issue's current task conversation.

        The runtime send is a device RPC that must run outside the webhook's
        event loop (it can take minutes), so the round is dispatched to a
        worker. The wait gate keeps waiting and the round counter moves only
        once the worker has sent the prompt into the existing task.
        """

        from app.tasks.external_event_tasks import dispatch_external_event_continue

        dispatch_external_event_continue.apply_async(
            kwargs={
                "binding_id": str(binding.id),
                "instruction": self._repair_instruction(rule, events),
            }
        )

    def continue_round(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        instruction: str,
    ) -> bool:
        """Send one repair prompt into the issue's current task conversation.

        Runs in the worker context where no event loop is active. A continue
        round does not create a new automation run or execution: the executor
        appends the prompt to the runtime task that actually ran most recently
        for this issue. The send is built from the robot configured on the wait
        node itself (its model is used to synthesize the runtime execution
        request), so a continue round never inherits a default task-mode bot.
        When the target or the robot cannot be resolved, the wait node records
        a visible error and the request is not silently dropped.
        """

        issue, node = self._issue_and_node(db, binding)
        if issue is None or node is None or node.status != "waiting":
            return False
        target = self._continue_target(db, binding)
        if target is None:
            self._record_continue_error(
                db, issue=issue, node=node, error="No runnable task for continue"
            )
            return False
        agent = self._wait_node_agent(
            db,
            cloud_project_id=str(binding.cloud_project_id),
            node=node,
        )
        if agent is None:
            self._record_continue_error(
                db,
                issue=issue,
                node=node,
                error="No active robot is configured on the wait node for continue",
            )
            return False
        model_selection = _continue_model_selection(agent)
        if model_selection is None:
            self._record_continue_error(
                db,
                issue=issue,
                node=node,
                error="The wait node robot has no model configured for continue",
            )
            return False
        try:
            self._send_continue_message(
                db,
                target=target,
                message=instruction,
                model_selection=model_selection,
            )
        except Exception as exc:
            logger.exception(
                "[ExternalEvent] Continue send failed binding=%s task=%s",
                binding.id,
                target[0].local_task_id,
            )
            self._record_continue_error(
                db,
                issue=issue,
                node=node,
                error=f"Continue send failed: {exc}"[:500],
            )
            return False
        self._bump_round(db, issue=issue, node=node)
        self._record_continue_error(db, issue=issue, node=node, error=None)
        return True

    @staticmethod
    def _continue_target(
        db: Session,
        binding: ExternalEventBinding,
    ) -> tuple[RuntimeTaskAddress, int] | None:
        """Resolve the runtime task that actually ran last for this issue."""

        execution = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == binding.loop_item_id,
                LoopItemExecution.runtime_device_id != "",
                LoopItemExecution.runtime_task_id != "",
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if execution is None:
            return None
        return (
            RuntimeTaskAddress(
                device_id=str(execution.runtime_device_id),
                local_task_id=str(execution.runtime_task_id),
            ),
            int(execution.executor_owner_user_id or 0),
        )

    @staticmethod
    def _send_continue_message(
        db: Session,
        *,
        target: tuple[RuntimeTaskAddress, int],
        message: str,
        model_selection: RuntimeModelSelection,
    ) -> None:
        """Dispatch one prompt into the target runtime task conversation."""

        from app.services import runtime_work_service

        address, user_id = target
        request = RuntimeSendRequest(
            address=address,
            message=message,
            model_selection=model_selection,
        )
        asyncio.run(
            runtime_work_service.send_runtime_message(
                db=db,
                user_id=user_id,
                request=request,
            )
        )

    @staticmethod
    def _record_continue_error(
        db: Session,
        *,
        issue: LoopItem,
        node: WorkflowNodeInstance,
        error: str | None,
    ) -> None:
        """Persist the last continue failure on the wait node.

        The error is part of the node snapshot the API exposes so a dead
        listener is visible on the card instead of living only in the logs. A
        later successful continue clears the field again.
        """

        raw_workflow = (
            issue.metadata_json.get("workflow")
            if isinstance(issue.metadata_json, dict)
            else None
        )
        if not isinstance(raw_workflow, dict):
            return
        nodes = [dict(candidate) for candidate in raw_workflow.get("nodes") or []]
        changed = False
        for candidate in nodes:
            if candidate.get("id") != node.id:
                continue
            if error and candidate.get("continue_error") != error:
                candidate["continue_error"] = error
                changed = True
            elif not error and candidate.get("continue_error"):
                candidate.pop("continue_error", None)
                changed = True
            break
        if not changed:
            return
        apply_workflow_nodes(issue, workflow=raw_workflow, nodes=nodes)
        db.commit()

    def _schedule_window(
        self,
        db: Session,
        *,
        binding: ExternalEventBinding,
        node: WorkflowNodeInstance,
        event: NormalizedExternalEvent,
        window_seconds: int,
    ) -> None:
        """Join or open a short-window aggregation for one windowed event."""

        task_id = binding.loop_item_id
        node_id = self._node_id(binding)
        if external_event_buffer.append_window(
            task_id=task_id,
            node_id=node_id,
            event_type=event.event_type,
            event=external_event_dict(event),
        ):
            return
        snapshot = external_event_buffer.open_window(
            task_id=task_id,
            node_id=node_id,
            event_type=event.event_type,
            event=external_event_dict(event),
            window_seconds=window_seconds,
        )
        if snapshot is None:
            return
        from app.tasks.external_event_tasks import settle_external_event_window

        settle_external_event_window.apply_async(
            kwargs={
                "binding_id": str(binding.id),
                "event_type": event.event_type,
                "generation": int(snapshot["generation"]),
            },
            countdown=window_seconds,
        )

    def _park_event(
        self,
        *,
        binding: ExternalEventBinding,
        event: NormalizedExternalEvent,
    ) -> None:
        self._park_events(binding=binding, events=[external_event_dict(event)])

    def _park_events(
        self,
        *,
        binding: ExternalEventBinding,
        events: list[dict[str, Any]],
    ) -> None:
        """Park events under the node aggregate while a repair round runs."""

        for event in events:
            if not isinstance(event, dict) or not event:
                continue
            event_type = str(event.get("event_type") or "")
            external_event_buffer.append(
                binding.provider,
                binding.opaque_ref,
                event_type,
                event,
            )
            external_event_buffer.push_aggregate(
                task_id=binding.loop_item_id,
                node_id=self._node_id(binding),
                provider=binding.provider,
                opaque_ref=binding.opaque_ref,
                event_type=event_type,
            )

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
            self._park_events(binding=binding, events=events)
            return
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or run.task_id != binding.loop_item_id:
            logger.warning(
                "External event rerun run mismatch binding=%s run=%s task=%s",
                binding.id,
                run_id,
                binding.loop_item_id,
            )
            self._park_events(binding=binding, events=events)
            return
        item = db.get(LoopItem, binding.loop_item_id)
        if item is None:
            self._park_events(binding=binding, events=events)
            return
        issue_id = self._metadata(binding).get("issue_item_id")
        issue = db.get(LoopItem, issue_id) if issue_id else item
        agent = self._wait_node_agent(
            db,
            cloud_project_id=str(run.cloud_project_id),
            node=node,
        )
        if agent is None:
            logger.warning(
                "External event rerun skipped: wait node has no active robot "
                "binding=%s node=%s",
                binding.id,
                node.id,
            )
            self._park_events(binding=binding, events=events)
            return
        instruction = self._repair_instruction(rule, events)
        # A repair round is its own run scoped to the wait node, exactly like
        # a stage rerun owns a fresh run. The stage that reached the gate
        # stays completed and is never re-activated by the round.
        try:
            # The rerun setup is one unit: bumping the round, creating the
            # wait-node run, rebinding metadata, and enqueueing the execution
            # either all persist or all roll back. The webhook request commits
            # the outer transaction afterwards, so a partial repair round must
            # never leak into it.
            with db.begin_nested():
                self._bump_round(db, issue=issue, node=node)
                rerun_run = self._rerun_run(
                    db,
                    run=run,
                    item=item,
                    issue=issue,
                    node=node,
                    instruction=instruction,
                    agent=agent,
                )
                binding_metadata = dict(self._metadata(binding))
                binding_metadata["automation_run_id"] = str(rerun_run.id)
                binding.metadata_json = binding_metadata
                execution = loop_item_execution_service.create_for_assignment(
                    db,
                    loop_item_id=item.id,
                    cloud_project_id=str(item.cloud_project_id),
                    agent=agent,
                    assigner_user_id=int(
                        run.created_by_user_id or agent.created_by_user_id or 0
                    ),
                    environment=str(self._agent_env(agent)),
                    execution_device_id=self._agent_device(agent),
                    priority=item.priority,
                    automation_context={
                        "rule_id": str(run.parent_id or ""),
                        "run_id": str(rerun_run.id),
                        "trigger": "external_event",
                    },
                )
                db.flush()
                if execution.team_id:
                    from app.services.board_team_execution import (
                        schedule_board_robot_execution,
                    )

                    schedule_board_robot_execution(db, execution)
        except Exception:
            logger.exception(
                "External event rerun setup failed binding=%s task=%s",
                binding.id,
                item.id,
            )
            self._park_events(binding=binding, events=events)
            raise
        logger.info(
            "[ExternalEvent] Rerun queued binding=%s task=%s execution=%s round=%s",
            binding.id,
            item.id,
            execution.id,
            node.wait_round + 1,
        )

    @staticmethod
    def _rerun_run(
        db: Session,
        *,
        run: ProjectAutomationRun,
        item: LoopItem,
        issue: LoopItem,
        node: WorkflowNodeInstance,
        instruction: str,
        agent: Any,
    ) -> ProjectAutomationRun:
        """Create the wait-node run that owns one repair round."""

        from app.services.workflow_stage_context import (
            workflow_stage_context_resolver,
        )

        snapshot = workflow_stage_context_resolver.resolve(
            db,
            item=issue,
            target_node_id=node.id,
            target_prompt_override=instruction,
        )
        row = ProjectAutomationRun(
            cloud_project_id=run.cloud_project_id,
            parent_id=run.parent_id,
            assignee_agent_id=agent.id,
            source="external_event",
            status="pending",
            due_at=None,
            task_id=item.id,
            task_title=item.title or "",
            created_by_user_id=run.created_by_user_id,
            metadata_json={
                "trigger": "external_event",
                "workflow_node_id": node.id,
                "workflow_stage_input": snapshot,
                "rerun_round": int(node.wait_round or 0) + 1,
            },
        )
        db.add(row)
        db.flush()
        return row

    @staticmethod
    def _repair_instruction(rule: WaitEventRule, events: list[dict[str, Any]]) -> str:
        summaries = [
            str(event.get("summary") or "") for event in events if event.get("summary")
        ]
        body = "\n".join(f"- {summary}" for summary in summaries) if summaries else ""
        base = (rule.prompt or "").strip()
        if not body:
            return base
        return (
            f"{base}\n\n外部事件概述：\n{body}" if base else f"外部事件概述：\n{body}"
        )

    @staticmethod
    def _wait_node_agent(
        db: Session,
        *,
        cloud_project_id: str,
        node: WorkflowNodeInstance,
    ):
        """Resolve the robot that owns wait-node repair rounds.

        Rerun and continue rounds both run on the robot configured on the wait
        node itself. The upstream stage that registered the binding is
        irrelevant: a repair round is scoped to the wait gate, not to whichever
        robot happened to reach it.
        """

        from app.models.delivery import ProjectChatAgent

        agent_id = node.wait_config.agent_id if node.wait_config else None
        agent = db.get(ProjectChatAgent, agent_id) if agent_id else None
        if (
            agent is None
            or agent.status != "active"
            or str(agent.cloud_project_id) != cloud_project_id
        ):
            return None
        return agent

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
        return [
            dict(node) for node in workflow.get("nodes") or [] if isinstance(node, dict)
        ]

    @staticmethod
    def _metadata(binding: ExternalEventBinding) -> dict[str, Any]:
        value = binding.metadata_json
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _node_id(binding: ExternalEventBinding) -> str:
        return str(
            (
                binding.metadata_json if isinstance(binding.metadata_json, dict) else {}
            ).get("workflow_node_id")
            or ""
        )

    @staticmethod
    def _matching_rule(
        node: WorkflowNodeInstance,
        provider: str,
        event_type: str,
    ) -> WaitEventRule | None:
        config = node.wait_config
        if config is None:
            return None
        return next(
            (
                rule
                for rule in config.rules
                if (rule.provider is None or rule.provider == provider)
                and rule.event_type == event_type
            ),
            None,
        )

    @staticmethod
    def _split_event_groups(
        events: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Split buffered events into the first (provider, event_type) group and the rest.

        Arrival order is preserved. The first group holds every event whose
        (provider, event_type) matches the oldest buffered event; everything
        else is returned as ``rest`` so each event type settles with its own
        declared delivery policy.
        """

        if not events:
            return [], []
        first = events[0]
        key = (str(first.get("provider") or ""), str(first.get("event_type") or ""))
        group: list[dict[str, Any]] = []
        rest: list[dict[str, Any]] = []
        for event in events:
            target = (
                group
                if (
                    str(event.get("provider") or ""),
                    str(event.get("event_type") or ""),
                )
                == key
                else rest
            )
            target.append(event)
        return group, rest

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
                str(value["event_id"]) if value.get("event_id") is not None else None
            ),
            summary=str(value.get("summary") or ""),
            source_url=(
                str(value["source_url"])
                if value.get("source_url") is not None
                else None
            ),
            occurred_at=None,
            detail=value.get("detail") if isinstance(value.get("detail"), dict) else {},
        )


def _continue_model_selection(agent: Any) -> RuntimeModelSelection | None:
    """Carry the wait-node robot's model into a runtime continue send.

    Codex-runtime robots use the "runtime" model type so the executor request
    is synthesized from the robot's model CRD instead of the default task-mode
    team, which may have no model of its own.
    """

    from app.services.project_chat.service import bot_config

    config = bot_config(agent)
    model = config.get("model")
    if not isinstance(model, str) or not model.strip():
        return None
    runtime = str(config.get("runtime") or "codex")
    model_type = "runtime" if runtime == "codex" else None
    return RuntimeModelSelection(
        model_name=model.strip(),
        model_type=model_type,
    )


external_event_evaluation_service = ExternalEventEvaluationService()
