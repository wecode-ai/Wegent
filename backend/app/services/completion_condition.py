# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Completion Condition Service for managing async completion conditions
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.completion_condition import (
    CompletionCondition,
    ConditionStatus,
    ConditionType,
    GitPlatform,
)
from app.schemas.completion_condition import (
    CompletionConditionCreate,
    CompletionConditionUpdate,
)
from app.services.base import BaseService

logger = logging.getLogger(__name__)


class CompletionConditionService(
    BaseService[CompletionCondition, CompletionConditionCreate, CompletionConditionUpdate]
):
    """Service for managing completion conditions"""

    def __init__(self):
        super().__init__(CompletionCondition)

    def create_condition(
        self,
        db: Session,
        *,
        obj_in: CompletionConditionCreate,
        user_id: int,
    ) -> CompletionCondition:
        """Create a new completion condition"""
        db_obj = CompletionCondition(
            subtask_id=obj_in.subtask_id,
            task_id=obj_in.task_id,
            user_id=user_id,
            condition_type=obj_in.condition_type,
            status=obj_in.status,
            external_id=obj_in.external_id,
            external_url=obj_in.external_url,
            git_platform=obj_in.git_platform,
            git_domain=obj_in.git_domain,
            repo_full_name=obj_in.repo_full_name,
            branch_name=obj_in.branch_name,
            max_retries=obj_in.max_retries,
            metadata=obj_in.metadata,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        logger.info(
            f"Created completion condition {db_obj.id} for subtask {obj_in.subtask_id}"
        )
        return db_obj

    def get_by_id(
        self,
        db: Session,
        *,
        condition_id: int,
        user_id: Optional[int] = None,
    ) -> Optional[CompletionCondition]:
        """Get a completion condition by ID"""
        query = db.query(CompletionCondition).filter(
            CompletionCondition.id == condition_id
        )
        if user_id is not None:
            query = query.filter(CompletionCondition.user_id == user_id)
        return query.first()

    def get_by_subtask_id(
        self,
        db: Session,
        *,
        subtask_id: int,
        user_id: Optional[int] = None,
    ) -> List[CompletionCondition]:
        """Get all completion conditions for a subtask"""
        query = db.query(CompletionCondition).filter(
            CompletionCondition.subtask_id == subtask_id
        )
        if user_id is not None:
            query = query.filter(CompletionCondition.user_id == user_id)
        return query.all()

    def get_by_task_id(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: Optional[int] = None,
    ) -> List[CompletionCondition]:
        """Get all completion conditions for a task"""
        query = db.query(CompletionCondition).filter(
            CompletionCondition.task_id == task_id
        )
        if user_id is not None:
            query = query.filter(CompletionCondition.user_id == user_id)
        return query.all()

    def find_by_repo_and_branch(
        self,
        db: Session,
        *,
        repo_full_name: str,
        branch_name: str,
        git_platform: Optional[GitPlatform] = None,
        status_list: Optional[List[ConditionStatus]] = None,
    ) -> List[CompletionCondition]:
        """Find completion conditions by repository and branch"""
        query = db.query(CompletionCondition).filter(
            and_(
                CompletionCondition.repo_full_name == repo_full_name,
                CompletionCondition.branch_name == branch_name,
            )
        )
        if git_platform:
            query = query.filter(CompletionCondition.git_platform == git_platform)
        if status_list:
            query = query.filter(CompletionCondition.status.in_(status_list))
        return query.all()

    def update_status(
        self,
        db: Session,
        *,
        condition_id: int,
        status: ConditionStatus,
        failure_log: Optional[str] = None,
    ) -> Optional[CompletionCondition]:
        """Update the status of a completion condition"""
        condition = self.get_by_id(db, condition_id=condition_id)
        if not condition:
            return None

        condition.status = status
        if failure_log:
            condition.last_failure_log = failure_log

        if status == ConditionStatus.SATISFIED:
            condition.satisfied_at = datetime.utcnow()

        db.commit()
        db.refresh(condition)
        logger.info(f"Updated condition {condition_id} status to {status}")
        return condition

    def increment_retry(
        self,
        db: Session,
        *,
        condition_id: int,
        failure_log: Optional[str] = None,
    ) -> Optional[CompletionCondition]:
        """Increment retry count and update failure log"""
        condition = self.get_by_id(db, condition_id=condition_id)
        if not condition:
            return None

        condition.retry_count += 1
        if failure_log:
            condition.last_failure_log = failure_log
        condition.status = ConditionStatus.PENDING

        db.commit()
        db.refresh(condition)
        logger.info(
            f"Incremented retry count for condition {condition_id} to {condition.retry_count}"
        )
        return condition

    def can_retry(self, condition: CompletionCondition) -> bool:
        """Check if a condition can be retried"""
        return condition.retry_count < condition.max_retries

    def cancel_by_subtask(
        self,
        db: Session,
        *,
        subtask_id: int,
    ) -> int:
        """Cancel all pending/in_progress conditions for a subtask"""
        conditions = (
            db.query(CompletionCondition)
            .filter(
                and_(
                    CompletionCondition.subtask_id == subtask_id,
                    CompletionCondition.status.in_(
                        [ConditionStatus.PENDING, ConditionStatus.IN_PROGRESS]
                    ),
                )
            )
            .all()
        )

        count = 0
        for condition in conditions:
            condition.status = ConditionStatus.CANCELLED
            count += 1

        db.commit()
        logger.info(f"Cancelled {count} conditions for subtask {subtask_id}")
        return count

    def cancel_by_task(
        self,
        db: Session,
        *,
        task_id: int,
    ) -> int:
        """Cancel all pending/in_progress conditions for a task"""
        conditions = (
            db.query(CompletionCondition)
            .filter(
                and_(
                    CompletionCondition.task_id == task_id,
                    CompletionCondition.status.in_(
                        [ConditionStatus.PENDING, ConditionStatus.IN_PROGRESS]
                    ),
                )
            )
            .all()
        )

        count = 0
        for condition in conditions:
            condition.status = ConditionStatus.CANCELLED
            count += 1

        db.commit()
        logger.info(f"Cancelled {count} conditions for task {task_id}")
        return count

    def get_task_completion_status(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get overall completion status for a task"""
        conditions = self.get_by_task_id(db, task_id=task_id, user_id=user_id)

        pending = sum(1 for c in conditions if c.status == ConditionStatus.PENDING)
        in_progress = sum(
            1 for c in conditions if c.status == ConditionStatus.IN_PROGRESS
        )
        satisfied = sum(
            1 for c in conditions if c.status == ConditionStatus.SATISFIED
        )
        failed = sum(1 for c in conditions if c.status == ConditionStatus.FAILED)

        # All conditions are satisfied if there are conditions and none are pending/in_progress/failed
        all_satisfied = (
            len(conditions) > 0
            and pending == 0
            and in_progress == 0
            and failed == 0
        )

        return {
            "task_id": task_id,
            "total_conditions": len(conditions),
            "pending_conditions": pending,
            "in_progress_conditions": in_progress,
            "satisfied_conditions": satisfied,
            "failed_conditions": failed,
            "all_conditions_satisfied": all_satisfied,
            "conditions": conditions,
        }

    def has_unsatisfied_conditions(
        self,
        db: Session,
        *,
        subtask_id: int,
    ) -> bool:
        """Check if a subtask has any unsatisfied (pending/in_progress) conditions"""
        count = (
            db.query(CompletionCondition)
            .filter(
                and_(
                    CompletionCondition.subtask_id == subtask_id,
                    CompletionCondition.status.in_(
                        [ConditionStatus.PENDING, ConditionStatus.IN_PROGRESS]
                    ),
                )
            )
            .count()
        )
        return count > 0


# Global service instance
completion_condition_service = CompletionConditionService()
