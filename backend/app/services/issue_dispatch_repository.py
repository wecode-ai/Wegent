# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistence access for Issue dispatch records stored in LoopNode."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.delivery import (
    IssueDispatch,
    IssueDispatchOutcome,
    IssueDispatchRound,
    IssueDispatchTask,
    LoopItem,
    loop_datetime_is_unset,
)


@dataclass(frozen=True)
class DispatchChain:
    dispatch: IssueDispatch
    issue: LoopItem


@dataclass(frozen=True)
class DispatchTaskChain:
    task: IssueDispatchTask
    round: IssueDispatchRound
    dispatch: IssueDispatch
    issue: LoopItem


class IssueDispatchRepository:
    """Keep all dispatch hierarchy queries in one place."""

    def active(self, db: Session, issue_id: str) -> IssueDispatch | None:
        return (
            db.query(IssueDispatch)
            .filter(
                IssueDispatch.parent_id == issue_id,
                IssueDispatch.status == "active",
                loop_datetime_is_unset(IssueDispatch.deleted_at),
            )
            .order_by(IssueDispatch.created_at.desc())
            .first()
        )

    def list(self, db: Session, issue_id: str) -> list[IssueDispatch]:
        return (
            db.query(IssueDispatch)
            .filter(
                IssueDispatch.parent_id == issue_id,
                loop_datetime_is_unset(IssueDispatch.deleted_at),
            )
            .order_by(IssueDispatch.created_at.desc())
            .all()
        )

    def by_idempotency(
        self, db: Session, issue_id: str, key: str
    ) -> IssueDispatch | None:
        return (
            db.query(IssueDispatch)
            .filter(
                IssueDispatch.parent_id == issue_id,
                IssueDispatch.metadata_json["idempotency_key"].as_string() == key,
                loop_datetime_is_unset(IssueDispatch.deleted_at),
            )
            .first()
        )

    def chain(
        self, db: Session, dispatch_id: str, *, for_update: bool = False
    ) -> DispatchChain | None:
        query = db.query(IssueDispatch).filter(IssueDispatch.id == dispatch_id)
        if for_update:
            query = query.with_for_update()
        dispatch = query.one_or_none()
        issue = db.get(LoopItem, dispatch.parent_id) if dispatch is not None else None
        if dispatch is None or issue is None:
            return None
        return DispatchChain(dispatch=dispatch, issue=issue)

    def rounds(self, db: Session, dispatch_id: str) -> list[IssueDispatchRound]:
        return (
            db.query(IssueDispatchRound)
            .filter(IssueDispatchRound.parent_id == dispatch_id)
            .order_by(IssueDispatchRound.sort_order, IssueDispatchRound.created_at)
            .all()
        )

    def active_round(self, db: Session, dispatch_id: str) -> IssueDispatchRound | None:
        return (
            db.query(IssueDispatchRound)
            .filter(
                IssueDispatchRound.parent_id == dispatch_id,
                IssueDispatchRound.status.in_({"planning", "executing", "evaluating"}),
            )
            .order_by(IssueDispatchRound.sort_order.desc())
            .first()
        )

    def round_by_idempotency(
        self, db: Session, dispatch_id: str, key: str
    ) -> IssueDispatchRound | None:
        return (
            db.query(IssueDispatchRound)
            .filter(
                IssueDispatchRound.parent_id == dispatch_id,
                IssueDispatchRound.metadata_json["idempotency_key"].as_string() == key,
            )
            .first()
        )

    def tasks(self, db: Session, round_id: str) -> list[IssueDispatchTask]:
        return (
            db.query(IssueDispatchTask)
            .filter(IssueDispatchTask.parent_id == round_id)
            .order_by(IssueDispatchTask.sort_order, IssueDispatchTask.created_at)
            .all()
        )

    def task_chain(
        self, db: Session, task_id: str, *, for_update: bool = False
    ) -> DispatchTaskChain | None:
        query = db.query(IssueDispatchTask).filter(IssueDispatchTask.id == task_id)
        if for_update:
            query = query.with_for_update()
        task = query.one_or_none()
        round_record = (
            db.get(IssueDispatchRound, task.parent_id) if task is not None else None
        )
        dispatch = (
            db.get(IssueDispatch, round_record.parent_id)
            if round_record is not None
            else None
        )
        issue = db.get(LoopItem, dispatch.parent_id) if dispatch is not None else None
        if task is None or round_record is None or dispatch is None or issue is None:
            return None
        return DispatchTaskChain(
            task=task,
            round=round_record,
            dispatch=dispatch,
            issue=issue,
        )

    def task_for_linked_item(
        self, db: Session, linked_item_id: str
    ) -> IssueDispatchTask | None:
        return (
            db.query(IssueDispatchTask)
            .filter(IssueDispatchTask.loop_item_id == linked_item_id)
            .order_by(IssueDispatchTask.created_at.desc())
            .first()
        )

    def outcome_by_event(
        self, db: Session, task_id: str, event_id: str
    ) -> IssueDispatchOutcome | None:
        return (
            db.query(IssueDispatchOutcome)
            .filter(
                IssueDispatchOutcome.parent_id == task_id,
                IssueDispatchOutcome.metadata_json["event_id"].as_string() == event_id,
            )
            .first()
        )


issue_dispatch_repository = IssueDispatchRepository()
