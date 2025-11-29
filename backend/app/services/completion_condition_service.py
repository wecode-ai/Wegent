# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
CompletionCondition service for managing completion conditions
"""

import logging
from datetime import datetime
from typing import List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.models.completion_condition import (
    CompletionCondition,
    ConditionStatus,
    ConditionType,
    GitPlatform,
)
from app.models.subtask import Subtask, SubtaskStatus
from app.schemas.completion_condition import (
    CompletionConditionCreate,
    CompletionConditionUpdate,
)

logger = logging.getLogger(__name__)


class CompletionConditionService:
    """Service for managing completion conditions"""

    def __init__(self, db: Session):
        self.db = db

    def create(self, condition: CompletionConditionCreate) -> CompletionCondition:
        """Create a new completion condition"""
        db_condition = CompletionCondition(
            subtask_id=condition.subtask_id,
            task_id=condition.task_id,
            user_id=condition.user_id,
            condition_type=condition.condition_type,
            status=ConditionStatus.PENDING,
            trigger_type=condition.trigger_type,
            external_id=condition.external_id,
            external_url=condition.external_url,
            git_platform=condition.git_platform,
            git_domain=condition.git_domain,
            repo_full_name=condition.repo_full_name,
            branch_name=condition.branch_name,
            max_retries=condition.max_retries,
            session_id=condition.session_id,
            executor_namespace=condition.executor_namespace,
            executor_name=condition.executor_name,
            metadata=condition.metadata,
        )
        self.db.add(db_condition)
        self.db.commit()
        self.db.refresh(db_condition)
        logger.info(
            f"Created completion condition {db_condition.id} for subtask {condition.subtask_id}"
        )
        return db_condition

    def get_by_id(self, condition_id: int) -> Optional[CompletionCondition]:
        """Get a completion condition by ID"""
        return self.db.query(CompletionCondition).filter(
            CompletionCondition.id == condition_id
        ).first()

    def get_by_subtask_id(self, subtask_id: int) -> List[CompletionCondition]:
        """Get all completion conditions for a subtask"""
        return self.db.query(CompletionCondition).filter(
            CompletionCondition.subtask_id == subtask_id
        ).all()

    def get_by_task_id(self, task_id: int) -> List[CompletionCondition]:
        """Get all completion conditions for a task"""
        return self.db.query(CompletionCondition).filter(
            CompletionCondition.task_id == task_id
        ).all()

    def get_by_repo_and_branch(
        self,
        repo_full_name: str,
        branch_name: str,
        status: Optional[ConditionStatus] = None,
    ) -> List[CompletionCondition]:
        """Get completion conditions by repository and branch"""
        query = self.db.query(CompletionCondition).filter(
            and_(
                CompletionCondition.repo_full_name == repo_full_name,
                CompletionCondition.branch_name == branch_name,
            )
        )
        if status:
            query = query.filter(CompletionCondition.status == status)
        return query.all()

    def get_pending_or_in_progress(
        self, repo_full_name: str, branch_name: str
    ) -> List[CompletionCondition]:
        """Get pending or in-progress conditions for a repo/branch"""
        return self.db.query(CompletionCondition).filter(
            and_(
                CompletionCondition.repo_full_name == repo_full_name,
                CompletionCondition.branch_name == branch_name,
                CompletionCondition.status.in_([
                    ConditionStatus.PENDING,
                    ConditionStatus.IN_PROGRESS,
                ]),
            )
        ).all()

    def update(
        self, condition_id: int, update_data: CompletionConditionUpdate
    ) -> Optional[CompletionCondition]:
        """Update a completion condition"""
        condition = self.get_by_id(condition_id)
        if not condition:
            return None

        update_dict = update_data.model_dump(exclude_unset=True)
        for key, value in update_dict.items():
            setattr(condition, key, value)

        self.db.commit()
        self.db.refresh(condition)
        logger.info(f"Updated completion condition {condition_id}")
        return condition

    def update_status(
        self,
        condition_id: int,
        status: ConditionStatus,
        failure_log: Optional[str] = None,
    ) -> Optional[CompletionCondition]:
        """Update the status of a completion condition"""
        condition = self.get_by_id(condition_id)
        if not condition:
            return None

        condition.status = status
        if failure_log:
            condition.last_failure_log = failure_log
        if status == ConditionStatus.SATISFIED:
            condition.satisfied_at = datetime.utcnow()

        self.db.commit()
        self.db.refresh(condition)
        logger.info(f"Updated condition {condition_id} status to {status}")
        return condition

    def increment_retry_count(
        self, condition_id: int, failure_log: Optional[str] = None
    ) -> Optional[CompletionCondition]:
        """Increment retry count and optionally set failure log"""
        condition = self.get_by_id(condition_id)
        if not condition:
            return None

        condition.retry_count += 1
        if failure_log:
            condition.last_failure_log = failure_log
        # Reset status to PENDING for next CI run
        condition.status = ConditionStatus.PENDING

        self.db.commit()
        self.db.refresh(condition)
        logger.info(
            f"Incremented retry count for condition {condition_id} to {condition.retry_count}"
        )
        return condition

    def cancel_by_subtask_id(self, subtask_id: int) -> int:
        """Cancel all conditions for a subtask"""
        count = self.db.query(CompletionCondition).filter(
            and_(
                CompletionCondition.subtask_id == subtask_id,
                CompletionCondition.status.in_([
                    ConditionStatus.PENDING,
                    ConditionStatus.IN_PROGRESS,
                ]),
            )
        ).update({"status": ConditionStatus.CANCELLED})
        self.db.commit()
        logger.info(f"Cancelled {count} conditions for subtask {subtask_id}")
        return count

    def check_all_satisfied(self, subtask_id: int) -> bool:
        """Check if all conditions for a subtask are satisfied"""
        conditions = self.get_by_subtask_id(subtask_id)
        if not conditions:
            return True
        return all(c.status == ConditionStatus.SATISFIED for c in conditions)

    def has_failed_condition(self, subtask_id: int) -> bool:
        """Check if any condition for a subtask has failed"""
        conditions = self.get_by_subtask_id(subtask_id)
        return any(c.status == ConditionStatus.FAILED for c in conditions)

    def update_subtask_status_if_needed(self, subtask_id: int) -> Optional[Subtask]:
        """Update subtask status based on completion conditions"""
        subtask = self.db.query(Subtask).filter(Subtask.id == subtask_id).first()
        if not subtask or subtask.status != SubtaskStatus.WAITING:
            return subtask

        if self.check_all_satisfied(subtask_id):
            subtask.status = SubtaskStatus.COMPLETED
            subtask.completed_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(subtask)
            logger.info(f"Subtask {subtask_id} marked as COMPLETED (all conditions satisfied)")
        elif self.has_failed_condition(subtask_id):
            subtask.status = SubtaskStatus.FAILED
            self.db.commit()
            self.db.refresh(subtask)
            logger.info(f"Subtask {subtask_id} marked as FAILED (condition failed)")

        return subtask


def get_completion_condition_service(db: Session) -> CompletionConditionService:
    """Factory function to create CompletionConditionService"""
    return CompletionConditionService(db)
