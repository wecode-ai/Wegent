# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Permission service for evaluation module access control.

Handles role-based permissions for private topics:
- Respondent: Can view topics and submit answers
- Grader: Can view answers and execute grading
"""

import logging
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from wecode.models.evaluation import (
    EvalPermission,
    EvalTopic,
    PermissionRole,
    TopicVisibility,
)

logger = logging.getLogger(__name__)


class PermissionService:
    """Service for managing evaluation permissions."""

    def can_view_topic(self, db: Session, topic: EvalTopic, user_id: int) -> bool:
        """
        Check if user can view a topic.

        Public topics are visible to all. Private topics require:
        - User is the creator, OR
        - User has any permission (respondent or grader)

        Args:
            db: Database session
            topic: Topic to check
            user_id: User ID to check

        Returns:
            True if user can view the topic
        """
        if topic.visibility == TopicVisibility.PUBLIC:
            return True

        if topic.creator_id == user_id:
            return True

        return self.has_permission(db, topic.id, user_id)

    def can_edit_topic(self, topic: EvalTopic, user_id: int) -> bool:
        """
        Check if user can edit a topic.

        Only the creator can edit a topic.

        Args:
            topic: Topic to check
            user_id: User ID to check

        Returns:
            True if user can edit the topic
        """
        return topic.creator_id == user_id

    def can_answer(
        self, db: Session, topic: EvalTopic, user_id: int
    ) -> bool:
        """
        Check if user can submit answers for a topic.

        Public topics allow anyone to answer. Private topics require:
        - User is the creator, OR
        - User has respondent (or grader) permission

        Args:
            db: Database session
            topic: Topic to check
            user_id: User ID to check

        Returns:
            True if user can submit answers
        """
        if topic.visibility == TopicVisibility.PUBLIC:
            return True

        if topic.creator_id == user_id:
            return True

        return self.has_permission(db, topic.id, user_id, PermissionRole.RESPONDENT)

    def can_grade(self, db: Session, topic: EvalTopic, user_id: int) -> bool:
        """
        Check if user can execute grading for a topic.

        Grading requires:
        - User is the creator, OR
        - User has grader permission

        Args:
            db: Database session
            topic: Topic to check
            user_id: User ID to check

        Returns:
            True if user can execute grading
        """
        if topic.creator_id == user_id:
            return True

        return self.has_permission(db, topic.id, user_id, PermissionRole.GRADER)

    def can_view_criteria(
        self, db: Session, topic: EvalTopic, user_id: int
    ) -> bool:
        """
        Check if user can view grading criteria.

        Only creators and graders can view criteria (not respondents).

        Args:
            db: Database session
            topic: Topic to check
            user_id: User ID to check

        Returns:
            True if user can view criteria
        """
        if topic.creator_id == user_id:
            return True

        return self.has_permission(db, topic.id, user_id, PermissionRole.GRADER)

    def can_view_all_answers(
        self, db: Session, topic: EvalTopic, user_id: int
    ) -> bool:
        """
        Check if user can view all answers for a topic.

        Only creators and graders can view all answers.

        Args:
            db: Database session
            topic: Topic to check
            user_id: User ID to check

        Returns:
            True if user can view all answers
        """
        if topic.creator_id == user_id:
            return True

        return self.has_permission(db, topic.id, user_id, PermissionRole.GRADER)

    def has_permission(
        self,
        db: Session,
        topic_id: int,
        user_id: int,
        role: Optional[str] = None,
    ) -> bool:
        """
        Check if user has specific permission for a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            user_id: User ID
            role: Required role (None = any role)

        Returns:
            True if user has the required permission
        """
        query = db.query(EvalPermission).filter(
            EvalPermission.topic_id == topic_id,
            EvalPermission.user_id == user_id,
        )

        if role:
            # Grader role implies respondent access
            if role == PermissionRole.RESPONDENT:
                query = query.filter(
                    EvalPermission.role.in_(
                        [PermissionRole.RESPONDENT, PermissionRole.GRADER]
                    )
                )
            else:
                query = query.filter(EvalPermission.role == role)

        return query.first() is not None

    def list_permissions(
        self,
        db: Session,
        topic_id: int,
        role: Optional[str] = None,
        page: int = 1,
        limit: int = 50,
    ) -> Tuple[List[EvalPermission], int]:
        """
        List permissions for a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            role: Filter by role (optional)
            page: Page number (1-indexed)
            limit: Items per page

        Returns:
            Tuple of (permissions list, total count)
        """
        query = db.query(EvalPermission).filter(
            EvalPermission.topic_id == topic_id
        )

        if role:
            query = query.filter(EvalPermission.role == role)

        total = query.count()
        permissions = (
            query.order_by(EvalPermission.granted_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return permissions, total

    def grant_permission(
        self,
        db: Session,
        topic_id: int,
        user_id: int,
        role: str,
        granted_by: int,
    ) -> EvalPermission:
        """
        Grant permission to a user for a topic.

        If user already has permission, updates the role.

        Args:
            db: Database session
            topic_id: Topic ID
            user_id: User ID to grant permission
            role: Role to grant ('respondent' or 'grader')
            granted_by: User ID granting the permission

        Returns:
            Created or updated permission
        """
        # Check for existing permission
        existing = (
            db.query(EvalPermission)
            .filter(
                EvalPermission.topic_id == topic_id,
                EvalPermission.user_id == user_id,
            )
            .first()
        )

        if existing:
            # Update existing permission
            existing.role = role
            existing.granted_by = granted_by
            db.flush()
            logger.info(
                f"Updated permission for user {user_id} on topic {topic_id}: {role}"
            )
            return existing

        # Create new permission
        permission = EvalPermission(
            topic_id=topic_id,
            user_id=user_id,
            role=role,
            granted_by=granted_by,
        )
        db.add(permission)
        db.flush()

        logger.info(
            f"Granted {role} permission to user {user_id} on topic {topic_id}"
        )
        return permission

    def revoke_permission(
        self,
        db: Session,
        topic_id: int,
        user_id: int,
    ) -> bool:
        """
        Revoke permission from a user for a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            user_id: User ID to revoke permission

        Returns:
            True if permission was revoked, False if not found
        """
        permission = (
            db.query(EvalPermission)
            .filter(
                EvalPermission.topic_id == topic_id,
                EvalPermission.user_id == user_id,
            )
            .first()
        )

        if not permission:
            return False

        db.delete(permission)
        db.flush()

        logger.info(f"Revoked permission for user {user_id} on topic {topic_id}")
        return True

    def batch_grant_permissions(
        self,
        db: Session,
        topic_id: int,
        user_ids: List[int],
        role: str,
        granted_by: int,
    ) -> List[EvalPermission]:
        """
        Grant permissions to multiple users.

        Args:
            db: Database session
            topic_id: Topic ID
            user_ids: List of user IDs
            role: Role to grant
            granted_by: User ID granting permissions

        Returns:
            List of created/updated permissions
        """
        permissions = []
        for user_id in user_ids:
            permission = self.grant_permission(
                db, topic_id, user_id, role, granted_by
            )
            permissions.append(permission)

        return permissions

    def get_user_role(
        self,
        db: Session,
        topic: EvalTopic,
        user_id: int,
    ) -> Optional[str]:
        """
        Get user's role for a topic.

        Args:
            db: Database session
            topic: Topic
            user_id: User ID

        Returns:
            'creator', 'grader', 'respondent', or None
        """
        if topic.creator_id == user_id:
            return "creator"

        permission = (
            db.query(EvalPermission)
            .filter(
                EvalPermission.topic_id == topic.id,
                EvalPermission.user_id == user_id,
            )
            .first()
        )

        return permission.role if permission else None
