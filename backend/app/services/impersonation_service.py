# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for handling impersonation requests and sessions.
"""

import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.impersonation import ImpersonationAuditLog, ImpersonationRequest
from app.models.user import User


class ImpersonationService:
    """Service for managing impersonation requests and sessions."""

    # Configuration with environment variable support
    REQUEST_EXPIRY_MINUTES = int(os.getenv("IMPERSONATION_REQUEST_EXPIRY_MINUTES", "30"))
    SESSION_EXPIRY_HOURS = int(os.getenv("IMPERSONATION_SESSION_EXPIRY_HOURS", "24"))
    AUDIT_RETENTION_DAYS = int(os.getenv("IMPERSONATION_AUDIT_RETENTION_DAYS", "30"))

    # Sensitive fields to redact in audit logs
    SENSITIVE_FIELDS = [
        "password",
        "token",
        "access_token",
        "api_key",
        "secret",
        "credential",
        "auth",
    ]

    def create_request(
        self, db: Session, admin_user: User, target_user_id: int
    ) -> ImpersonationRequest:
        """
        Create a new impersonation request.

        Args:
            db: Database session
            admin_user: Admin user creating the request
            target_user_id: ID of the user to impersonate

        Returns:
            Created impersonation request
        """
        # Verify target user exists and is active
        target_user = db.query(User).filter(User.id == target_user_id).first()
        if not target_user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"User with id {target_user_id} not found",
            )

        if not target_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot impersonate inactive user",
            )

        # Check for existing pending requests for the same target user
        existing_request = (
            db.query(ImpersonationRequest)
            .filter(
                ImpersonationRequest.admin_user_id == admin_user.id,
                ImpersonationRequest.target_user_id == target_user_id,
                ImpersonationRequest.status == "pending",
                ImpersonationRequest.expires_at > datetime.now(timezone.utc),
            )
            .first()
        )

        if existing_request:
            # Return existing request instead of creating a new one
            return existing_request

        # Generate unique token
        token = secrets.token_urlsafe(32)

        # Create request
        request = ImpersonationRequest(
            admin_user_id=admin_user.id,
            target_user_id=target_user_id,
            token=token,
            status="pending",
            expires_at=datetime.now(timezone.utc)
            + timedelta(minutes=self.REQUEST_EXPIRY_MINUTES),
        )

        db.add(request)
        db.commit()
        db.refresh(request)

        return request

    def get_request(
        self, db: Session, request_id: int, admin_user_id: Optional[int] = None
    ) -> ImpersonationRequest:
        """
        Get an impersonation request by ID.

        Args:
            db: Database session
            request_id: Request ID
            admin_user_id: If provided, verify the request belongs to this admin

        Returns:
            Impersonation request
        """
        query = db.query(ImpersonationRequest).filter(
            ImpersonationRequest.id == request_id
        )

        if admin_user_id:
            query = query.filter(ImpersonationRequest.admin_user_id == admin_user_id)

        request = query.first()
        if not request:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Impersonation request not found",
            )

        return request

    def get_request_by_token(self, db: Session, token: str) -> ImpersonationRequest:
        """
        Get an impersonation request by token.

        Args:
            db: Database session
            token: Request token

        Returns:
            Impersonation request
        """
        request = (
            db.query(ImpersonationRequest)
            .filter(ImpersonationRequest.token == token)
            .first()
        )

        if not request:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Impersonation request not found",
            )

        return request

    def list_requests(
        self,
        db: Session,
        admin_user_id: int,
        page: int = 1,
        limit: int = 20,
        status_filter: Optional[str] = None,
    ) -> Tuple[List[ImpersonationRequest], int]:
        """
        List impersonation requests for an admin user.

        Args:
            db: Database session
            admin_user_id: Admin user ID
            page: Page number
            limit: Items per page
            status_filter: Optional status filter

        Returns:
            Tuple of (requests list, total count)
        """
        query = db.query(ImpersonationRequest).filter(
            ImpersonationRequest.admin_user_id == admin_user_id
        )

        if status_filter:
            query = query.filter(ImpersonationRequest.status == status_filter)

        total = query.count()
        requests = (
            query.order_by(ImpersonationRequest.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return requests, total

    def cancel_request(
        self, db: Session, request_id: int, admin_user_id: int
    ) -> ImpersonationRequest:
        """
        Cancel a pending impersonation request.

        Args:
            db: Database session
            request_id: Request ID
            admin_user_id: Admin user ID

        Returns:
            Cancelled request
        """
        request = self.get_request(db, request_id, admin_user_id)

        if request.status != "pending":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot cancel request with status '{request.status}'",
            )

        request.status = "expired"
        db.commit()
        db.refresh(request)

        return request

    def approve_request(
        self, db: Session, token: str, target_user: User
    ) -> ImpersonationRequest:
        """
        Approve an impersonation request.

        Args:
            db: Database session
            token: Request token
            target_user: Target user approving the request

        Returns:
            Approved request
        """
        request = self.get_request_by_token(db, token)

        # Verify the request belongs to the target user
        if request.target_user_id != target_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not authorized to approve this request",
            )

        # Check request status
        if request.status != "pending":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Request is already {request.status}",
            )

        # Check expiration
        if request.expires_at < datetime.now(timezone.utc):
            request.status = "expired"
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Request has expired",
            )

        # Approve the request
        request.status = "approved"
        request.approved_at = datetime.now(timezone.utc)
        request.session_expires_at = datetime.now(timezone.utc) + timedelta(
            hours=self.SESSION_EXPIRY_HOURS
        )
        db.commit()
        db.refresh(request)

        return request

    def reject_request(
        self, db: Session, token: str, target_user: User
    ) -> ImpersonationRequest:
        """
        Reject an impersonation request.

        Args:
            db: Database session
            token: Request token
            target_user: Target user rejecting the request

        Returns:
            Rejected request
        """
        request = self.get_request_by_token(db, token)

        # Verify the request belongs to the target user
        if request.target_user_id != target_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not authorized to reject this request",
            )

        # Check request status
        if request.status != "pending":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Request is already {request.status}",
            )

        # Reject the request
        request.status = "rejected"
        db.commit()
        db.refresh(request)

        return request

    def start_session(
        self, db: Session, request_id: int, admin_user: User
    ) -> Tuple[ImpersonationRequest, User]:
        """
        Start an impersonation session.

        Args:
            db: Database session
            request_id: Request ID
            admin_user: Admin user starting the session

        Returns:
            Tuple of (request, target_user)
        """
        request = self.get_request(db, request_id, admin_user.id)

        # Verify request is approved
        if request.status != "approved":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot start session for request with status '{request.status}'",
            )

        # Check session expiration
        if (
            request.session_expires_at
            and request.session_expires_at < datetime.now(timezone.utc)
        ):
            request.status = "expired"
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Session has expired",
            )

        # Mark request as used
        request.status = "used"
        db.commit()
        db.refresh(request)

        # Get target user
        target_user = (
            db.query(User).filter(User.id == request.target_user_id).first()
        )

        return request, target_user

    def expire_old_requests(self, db: Session) -> int:
        """
        Expire old pending requests.

        Args:
            db: Database session

        Returns:
            Number of expired requests
        """
        result = (
            db.query(ImpersonationRequest)
            .filter(
                ImpersonationRequest.status == "pending",
                ImpersonationRequest.expires_at < datetime.now(timezone.utc),
            )
            .update({"status": "expired"})
        )
        db.commit()
        return result

    def cleanup_old_audit_logs(self, db: Session) -> int:
        """
        Delete audit logs older than retention period.

        Args:
            db: Database session

        Returns:
            Number of deleted logs
        """
        cutoff_date = datetime.now(timezone.utc) - timedelta(
            days=self.AUDIT_RETENTION_DAYS
        )
        result = (
            db.query(ImpersonationAuditLog)
            .filter(ImpersonationAuditLog.created_at < cutoff_date)
            .delete()
        )
        db.commit()
        return result

    def log_action(
        self,
        db: Session,
        request_id: int,
        admin_user_id: int,
        target_user_id: int,
        action: str,
        method: str,
        path: str,
        request_body: Optional[str] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> ImpersonationAuditLog:
        """
        Log an action during impersonation session.

        Args:
            db: Database session
            request_id: Impersonation request ID
            admin_user_id: Admin user ID
            target_user_id: Target user ID
            action: Action type
            method: HTTP method
            path: Request path
            request_body: Request body (will be sanitized)
            ip_address: Client IP address
            user_agent: Client user agent

        Returns:
            Created audit log
        """
        # Sanitize request body
        sanitized_body = self._sanitize_sensitive_data(request_body)

        log = ImpersonationAuditLog(
            impersonation_request_id=request_id,
            admin_user_id=admin_user_id,
            target_user_id=target_user_id,
            action=action,
            method=method,
            path=path,
            request_body=sanitized_body,
            ip_address=ip_address,
            user_agent=user_agent[:500] if user_agent else None,
        )

        db.add(log)
        db.commit()
        db.refresh(log)

        return log

    def list_audit_logs(
        self,
        db: Session,
        page: int = 1,
        limit: int = 50,
        request_id: Optional[int] = None,
        admin_user_id: Optional[int] = None,
        target_user_id: Optional[int] = None,
    ) -> Tuple[List[ImpersonationAuditLog], int]:
        """
        List audit logs with filters.

        Args:
            db: Database session
            page: Page number
            limit: Items per page
            request_id: Filter by request ID
            admin_user_id: Filter by admin user ID
            target_user_id: Filter by target user ID

        Returns:
            Tuple of (logs list, total count)
        """
        query = db.query(ImpersonationAuditLog)

        if request_id:
            query = query.filter(
                ImpersonationAuditLog.impersonation_request_id == request_id
            )
        if admin_user_id:
            query = query.filter(
                ImpersonationAuditLog.admin_user_id == admin_user_id
            )
        if target_user_id:
            query = query.filter(
                ImpersonationAuditLog.target_user_id == target_user_id
            )

        total = query.count()
        logs = (
            query.order_by(ImpersonationAuditLog.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return logs, total

    def _sanitize_sensitive_data(self, data: Optional[str]) -> Optional[str]:
        """
        Sanitize sensitive data from request body.

        Args:
            data: Raw request body

        Returns:
            Sanitized request body
        """
        if not data:
            return None

        try:
            # Try to parse as JSON
            parsed = json.loads(data)
            sanitized = self._redact_sensitive_fields(parsed)
            return json.dumps(sanitized)
        except (json.JSONDecodeError, TypeError):
            # If not JSON, use regex to redact sensitive patterns
            result = data
            for field in self.SENSITIVE_FIELDS:
                pattern = rf'("{field}":\s*")[^"]*(")'
                result = re.sub(pattern, r'\1[REDACTED]\2', result, flags=re.IGNORECASE)
            return result

    def _redact_sensitive_fields(self, obj: Any) -> Any:
        """
        Recursively redact sensitive fields from an object.

        Args:
            obj: Object to redact

        Returns:
            Redacted object
        """
        if isinstance(obj, dict):
            return {
                k: "[REDACTED]"
                if any(s in k.lower() for s in self.SENSITIVE_FIELDS)
                else self._redact_sensitive_fields(v)
                for k, v in obj.items()
            }
        elif isinstance(obj, list):
            return [self._redact_sensitive_fields(item) for item in obj]
        return obj

    def get_confirmation_url(self, token: str) -> str:
        """
        Generate confirmation URL for impersonation request.

        Args:
            token: Request token

        Returns:
            Confirmation URL
        """
        frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
        return f"{frontend_url}/impersonate/confirm/{token}"


# Singleton instance
impersonation_service = ImpersonationService()
