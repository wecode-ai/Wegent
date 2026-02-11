# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base service for unified resource sharing.

Provides common functionality for share links and resource members management.
Resource-specific services should extend this base class.
"""

import base64
import logging
import urllib.parse
from abc import ABC, abstractmethod
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import PermissionLevel, ResourceType, ShareLink
from app.models.user import User
from app.schemas.share import (
    JoinByLinkResponse,
    MemberListResponse,
)
from app.schemas.share import MemberStatus as SchemaMemberStatus
from app.schemas.share import (
    PendingRequestListResponse,
    PendingRequestResponse,
)
from app.schemas.share import PermissionLevel as SchemaPermissionLevel
from app.schemas.share import (
    ResourceMemberResponse,
    ReviewRequestResponse,
    ShareInfoResponse,
    ShareLinkConfig,
    ShareLinkResponse,
)

logger = logging.getLogger(__name__)


class UnifiedShareService(ABC):
    """
    Base class for unified resource sharing.

    Provides common functionality:
    - AES token encryption/decryption
    - Share link CRUD operations
    - Resource member CRUD operations
    - Permission checking

    Subclasses must implement:
    - _get_resource(): Fetch and validate the resource
    - _get_resource_name(): Get resource display name
    - _get_resource_owner_id(): Get resource owner user ID
    - _get_share_url_base(): Get base URL for share links
    - _on_member_approved(): Hook called when member is approved
    """

    # Permission hierarchy for comparison
    PERMISSION_HIERARCHY: Dict[str, int] = {
        PermissionLevel.VIEW.value: 1,
        PermissionLevel.EDIT.value: 2,
        PermissionLevel.MANAGE.value: 3,
    }

    def __init__(self, resource_type: ResourceType):
        """Initialize the share service for a specific resource type."""
        self.resource_type = resource_type
        self.aes_key = settings.SHARE_TOKEN_AES_KEY.encode("utf-8")
        self.aes_iv = settings.SHARE_TOKEN_AES_IV.encode("utf-8")

    # =========================================================================
    # Abstract methods (must be implemented by subclasses)
    # =========================================================================

    @abstractmethod
    def _get_resource(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[object]:
        """
        Fetch and validate the resource exists and user has access.

        Args:
            db: Database session
            resource_id: Resource ID
            user_id: Current user ID (for ownership check)

        Returns:
            Resource object if found and accessible, None otherwise
        """
        pass

    @abstractmethod
    def _get_resource_name(self, resource: object) -> str:
        """Get display name for the resource."""
        pass

    @abstractmethod
    def _get_resource_owner_id(self, resource: object) -> int:
        """Get owner user ID for the resource."""
        pass

    @abstractmethod
    def _get_share_url_base(self) -> str:
        """Get base URL for share links."""
        pass

    @abstractmethod
    def _on_member_approved(
        self, db: Session, member: ResourceMember, resource: object
    ) -> Optional[int]:
        """
        Hook called when a member is approved.

        For Task resources, this should implement copy logic.
        For other resources, this can be a no-op.

        Args:
            db: Database session
            member: The approved member record
            resource: The resource being shared

        Returns:
            Copied resource ID (for Task type) or None
        """
        pass

    # =========================================================================
    # AES Encryption/Decryption
    # =========================================================================

    def _aes_encrypt(self, data: str) -> str:
        """Encrypt data using AES-256-CBC."""
        cipher = Cipher(
            algorithms.AES(self.aes_key),
            modes.CBC(self.aes_iv),
            backend=default_backend(),
        )
        encryptor = cipher.encryptor()

        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(data.encode("utf-8")) + padder.finalize()

        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()
        return base64.b64encode(encrypted_bytes).decode("utf-8")

    def _aes_decrypt(self, encrypted_data: str) -> Optional[str]:
        """Decrypt data using AES-256-CBC."""
        try:
            encrypted_bytes = base64.b64decode(encrypted_data.encode("utf-8"))

            cipher = Cipher(
                algorithms.AES(self.aes_key),
                modes.CBC(self.aes_iv),
                backend=default_backend(),
            )
            decryptor = cipher.decryptor()

            decrypted_padded_bytes = (
                decryptor.update(encrypted_bytes) + decryptor.finalize()
            )

            unpadder = padding.PKCS7(128).unpadder()
            decrypted_bytes = (
                unpadder.update(decrypted_padded_bytes) + unpadder.finalize()
            )

            return decrypted_bytes.decode("utf-8")
        except Exception:
            return None

    def _generate_share_token(self, user_id: int, resource_id: int) -> str:
        """Generate encrypted share token."""
        # Format: "resource_type#user_id#resource_id"
        share_data = f"{self.resource_type.value}#{user_id}#{resource_id}"
        token = self._aes_encrypt(share_data)
        return urllib.parse.quote(token)

    def _decode_share_token(self, share_token: str) -> Optional[Tuple[str, int, int]]:
        """
        Decode share token to get resource info.

        The token may come in different encoding states:
        1. URL-encoded (from database or direct copy)
        2. URL-decoded (from browser URL parsing)
        3. Double-decoded (if frontend encodes and FastAPI decodes)
        4. Space-corrupted (if + was converted to space during URL handling)

        We try multiple decoding strategies to handle all cases.

        Returns:
            Tuple of (resource_type, user_id, resource_id) or None if invalid
        """
        # Try different decoding strategies
        # Note: Base64 uses +, /, = which can be problematic in URLs
        # - + can be interpreted as space in query strings
        # - / needs to be encoded as %2F
        # - = needs to be encoded as %3D
        tokens_to_try = [
            share_token,  # Try as-is first
            urllib.parse.unquote(share_token),  # Try URL-decoded
            urllib.parse.unquote_plus(share_token),  # Try with + as space handling
            # If space was incorrectly introduced (+ -> space), convert back
            share_token.replace(" ", "+"),
            urllib.parse.unquote(share_token).replace(" ", "+"),
        ]

        # Remove duplicates while preserving order
        seen = set()
        unique_tokens = []
        for token in tokens_to_try:
            if token not in seen:
                seen.add(token)
                unique_tokens.append(token)

        for token in unique_tokens:
            try:
                share_data_str = self._aes_decrypt(token)
                if not share_data_str:
                    continue

                parts = share_data_str.split("#")
                if len(parts) != 3:
                    continue

                resource_type = parts[0]
                user_id = int(parts[1])
                resource_id = int(parts[2])

                return (resource_type, user_id, resource_id)
            except Exception:
                continue

        return None

    def _generate_share_url(self, share_token: str) -> str:
        """Generate full share URL."""
        base_url = self._get_share_url_base()
        return f"{base_url}?token={share_token}"

    # =========================================================================
    # Share Link Operations
    # =========================================================================

    def create_share_link(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
        config: ShareLinkConfig,
    ) -> ShareLinkResponse:
        """Create or update a share link for a resource."""
        logger.info(
            f"[create_share_link] START: resource_type={self.resource_type.value}, "
            f"resource_id={resource_id}, user_id={user_id}"
        )

        # Validate resource exists and user is owner
        resource = self._get_resource(db, resource_id, user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        logger.info(
            f"[create_share_link] Owner check: owner_id={owner_id}, user_id={user_id}"
        )

        if owner_id != user_id:
            raise HTTPException(
                status_code=403, detail="Only resource owner can create share link"
            )

        # Check for existing active share link
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        # We need to check both formats to handle legacy data
        resource_type_variants = [self.resource_type.value]

        # Add underscore variant for KnowledgeBase -> KNOWLEDGE_BASE
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        existing_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        logger.info(
            f"[create_share_link] Existing link check: "
            f"found={existing_link is not None}, "
            f"existing_link_id={existing_link.id if existing_link else None}, "
            f"existing_token={existing_link.share_token[:50] + '...' if existing_link and existing_link.share_token else None}"
        )

        if existing_link:
            # Update existing link
            logger.info(
                f"[create_share_link] UPDATING existing link: id={existing_link.id}"
            )
            existing_link.require_approval = config.require_approval
            existing_link.default_permission_level = (
                config.default_permission_level.value
            )
            if config.expires_in_hours:
                existing_link.expires_at = datetime.utcnow() + timedelta(
                    hours=config.expires_in_hours
                )
            else:
                # Set to far future instead of None to avoid NOT NULL constraint
                existing_link.expires_at = datetime.utcnow() + timedelta(days=365 * 100)
            existing_link.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(existing_link)

            return self._share_link_to_response(existing_link)

        # Generate new share token
        logger.info(f"[create_share_link] No existing link found, generating new token")
        share_token = self._generate_share_token(user_id, resource_id)
        logger.info(f"[create_share_link] Generated share_token: {share_token[:50]}...")

        # ADDITIONAL DIAGNOSTIC: Check if this token already exists in DB
        duplicate_check = (
            db.query(ShareLink).filter(ShareLink.share_token == share_token).first()
        )
        if duplicate_check:
            logger.error(
                f"[create_share_link] CRITICAL: Generated token already exists! "
                f"duplicate_link_id={duplicate_check.id}, "
                f"duplicate_resource_type={duplicate_check.resource_type}, "
                f"duplicate_resource_id={duplicate_check.resource_id}, "
                f"duplicate_is_active={duplicate_check.is_active}, "
                f"token={share_token[:50]}..."
            )
        else:
            logger.info(
                f"[create_share_link] Token uniqueness check passed: no duplicate found"
            )

        # Calculate expiration
        # Use far future instead of None to avoid NOT NULL constraint
        if config.expires_in_hours:
            expires_at = datetime.utcnow() + timedelta(hours=config.expires_in_hours)
        else:
            expires_at = datetime.utcnow() + timedelta(days=365 * 100)

        # Create new share link
        logger.info(
            f"[create_share_link] Creating new ShareLink record with token: {share_token[:50]}..."
        )
        share_link = ShareLink(
            resource_type=self.resource_type.value,
            resource_id=resource_id,
            share_token=share_token,
            require_approval=config.require_approval,
            default_permission_level=config.default_permission_level.value,
            expires_at=expires_at,
            created_by_user_id=user_id,
            is_active=True,
        )

        db.add(share_link)

        try:
            db.commit()
            logger.info(
                f"[create_share_link] Successfully committed new share_link: id={share_link.id}"
            )
        except Exception as e:
            logger.error(
                f"[create_share_link] FAILED to commit share_link: {type(e).__name__}: {str(e)}"
            )
            logger.error(
                f"[create_share_link] Share link details that failed: "
                f"resource_type={self.resource_type.value}, "
                f"resource_id={resource_id}, "
                f"share_token={share_token[:50]}..., "
                f"created_by_user_id={user_id}"
            )
            raise

        db.refresh(share_link)

        logger.info(
            f"[create_share_link] END: Successfully created share_link id={share_link.id}"
        )
        return self._share_link_to_response(share_link)

    def get_share_link(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[ShareLinkResponse]:
        """Get active share link for a resource."""
        # Validate resource access
        resource = self._get_resource(db, resource_id, user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        if not share_link:
            return None

        return self._share_link_to_response(share_link)

    def delete_share_link(self, db: Session, resource_id: int, user_id: int) -> bool:
        """Deactivate share link for a resource."""
        # Validate resource and ownership
        resource = self._get_resource(db, resource_id, user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        if owner_id != user_id:
            raise HTTPException(
                status_code=403, detail="Only resource owner can delete share link"
            )

        # Note: Database may store resource_type in different formats
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        if not share_link:
            raise HTTPException(status_code=404, detail="Share link not found")

        share_link.is_active = False
        share_link.updated_at = datetime.utcnow()
        db.commit()

        return True

    def _share_link_to_response(self, share_link: ShareLink) -> ShareLinkResponse:
        """Convert ShareLink model to response schema."""
        return ShareLinkResponse(
            id=share_link.id,
            resource_type=share_link.resource_type,
            resource_id=share_link.resource_id,
            share_url=self._generate_share_url(share_link.share_token),
            share_token=share_link.share_token,
            require_approval=share_link.require_approval,
            default_permission_level=share_link.default_permission_level,
            expires_at=share_link.expires_at,
            is_active=share_link.is_active,
            created_by_user_id=share_link.created_by_user_id,
            created_at=share_link.created_at,
            updated_at=share_link.updated_at,
        )

    # =========================================================================
    # Public Info (for share link preview)
    # =========================================================================

    def get_share_info(self, db: Session, share_token: str) -> ShareInfoResponse:
        """Get public info about a share link (no auth required)."""
        # Decode token
        token_info = self._decode_share_token(share_token)
        if not token_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        resource_type, owner_id, resource_id = token_info

        # Validate resource type matches
        if resource_type != self.resource_type.value:
            raise HTTPException(status_code=400, detail="Invalid resource type")

        # Find share link by resource_id (not by token, since token encoding may vary)
        # Note: Database may store resource_type in different formats
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        if not share_link:
            raise HTTPException(
                status_code=404, detail="Share link not found or inactive"
            )

        # Check expiration
        is_expired = False
        if share_link.expires_at and datetime.utcnow() > share_link.expires_at:
            is_expired = True

        # Get resource (without user validation)
        resource = self._get_resource(db, resource_id, owner_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        # Get owner info
        owner = (
            db.query(User).filter(User.id == owner_id, User.is_active == True).first()
        )
        owner_name = owner.user_name if owner else f"User_{owner_id}"

        return ShareInfoResponse(
            resource_type=self.resource_type.value,
            resource_id=resource_id,
            resource_name=self._get_resource_name(resource),
            owner_user_id=owner_id,
            owner_user_name=owner_name,
            require_approval=share_link.require_approval,
            default_permission_level=share_link.default_permission_level,
            is_expired=is_expired,
        )

    # =========================================================================
    # Join Operations
    # =========================================================================

    def join_by_link(
        self,
        db: Session,
        share_token: str,
        user_id: int,
        requested_permission_level: Optional[SchemaPermissionLevel] = None,
    ) -> JoinByLinkResponse:
        """Handle join request via share link."""
        # Decode token
        token_info = self._decode_share_token(share_token)
        if not token_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        resource_type, owner_id, resource_id = token_info

        # Validate resource type
        if resource_type != self.resource_type.value:
            raise HTTPException(status_code=400, detail="Invalid resource type")

        # Cannot join own resource
        # Cannot join own resource
        if owner_id == user_id:
            raise HTTPException(status_code=400, detail="Cannot join your own resource")

        # Find share link by resource_id (not by token, since token encoding may vary)
        # Note: Database may store resource_type in different formats
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active == True,
            )
            .first()
        )
        if not share_link:
            raise HTTPException(
                status_code=404, detail="Share link not found or inactive"
            )

        # Check expiration
        if share_link.expires_at and datetime.utcnow() > share_link.expires_at:
            raise HTTPException(status_code=400, detail="Share link has expired")

        # Get resource
        resource = self._get_resource(db, resource_id, owner_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        # Check for existing member record
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        # We need to check both formats to handle legacy data and prevent duplicate records
        existing_member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.user_id == user_id,
            )
            .first()
        )

        if existing_member:
            # Note: Database may store status in different formats (e.g., "APPROVED" vs "approved")
            if existing_member.status.lower() == MemberStatus.APPROVED.value.lower():
                raise HTTPException(
                    status_code=400, detail="Already have access to this resource"
                )
            elif existing_member.status.lower() == MemberStatus.PENDING.value.lower():
                raise HTTPException(
                    status_code=400, detail="Request already pending approval"
                )
            # If rejected, allow re-request by updating the record
            is_pending = share_link.require_approval
            existing_member.status = (
                MemberStatus.PENDING.value
                if is_pending
                else MemberStatus.APPROVED.value
            )
            # Only use requested_permission_level when require_approval is True
            # Otherwise, always use share_link.default_permission_level to prevent self-elevation
            existing_member.permission_level = (
                requested_permission_level.value
                if is_pending and requested_permission_level
                else share_link.default_permission_level
            )
            existing_member.share_link_id = share_link.id
            existing_member.requested_at = datetime.utcnow()
            # For PENDING status, use 0 as placeholder; for APPROVED, use owner_id
            existing_member.reviewed_by_user_id = 0 if is_pending else owner_id
            existing_member.reviewed_at = datetime.utcnow()
            existing_member.updated_at = datetime.utcnow()

            member = existing_member
        else:
            # Determine initial status
            is_pending = share_link.require_approval
            initial_status = (
                MemberStatus.PENDING.value
                if is_pending
                else MemberStatus.APPROVED.value
            )

            # Determine permission level
            # Only use requested_permission_level when require_approval is True
            # Otherwise, always use share_link.default_permission_level to prevent self-elevation
            permission_level = (
                requested_permission_level.value
                if is_pending and requested_permission_level
                else share_link.default_permission_level
            )

            # Create member record
            # For PENDING status, use 0 as placeholder for reviewed_by_user_id
            # For APPROVED (auto-approved), use owner_id
            member = ResourceMember(
                resource_type=self.resource_type.value,
                resource_id=resource_id,
                user_id=user_id,
                permission_level=permission_level,
                status=initial_status,
                invited_by_user_id=0,  # Via link
                share_link_id=share_link.id,
                reviewed_by_user_id=0 if is_pending else owner_id,
                reviewed_at=datetime.utcnow(),
            )

            db.add(member)

        db.commit()
        db.refresh(member)

        # If auto-approved, call the approval hook
        copied_resource_id = None
        if member.status == MemberStatus.APPROVED.value:
            copied_resource_id = self._on_member_approved(db, member, resource)
            if copied_resource_id:
                member.copied_resource_id = copied_resource_id
                db.commit()

        return JoinByLinkResponse(
            message=(
                "Request submitted for approval"
                if member.status == MemberStatus.PENDING.value
                else "Successfully joined"
            ),
            status=SchemaMemberStatus(member.status),
            member_id=member.id,
            resource_type=self.resource_type.value,
            resource_id=resource_id,
            copied_resource_id=copied_resource_id,
        )

    # =========================================================================
    # Member Operations
    # =========================================================================

    def get_members(
        self, db: Session, resource_id: int, user_id: int
    ) -> MemberListResponse:
        """Get all members of a resource."""
        # Validate resource access
        resource = self._get_resource(db, resource_id, user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        # We need to query both formats to handle legacy data
        resource_type_variants = [self.resource_type.value]

        # Add underscore variant for KnowledgeBase -> KNOWLEDGE_BASE
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Note: Database may store status in different formats (e.g., "APPROVED" vs "approved")
        approved_status_variants = [
            MemberStatus.APPROVED.value,
            MemberStatus.APPROVED.value.upper(),
        ]

        all_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.status.in_(approved_status_variants),
            )
            .all()
        )

        # Deduplicate members by user_id (keep the first one found for each user)
        # This handles legacy data where the same user may have multiple records
        # with different resource_type formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        seen_user_ids = set()
        members = []
        for member in all_members:
            if member.user_id not in seen_user_ids:
                seen_user_ids.add(member.user_id)
                members.append(member)

        # LOGGING: Log query parameters and results to verify resource_type matching
        logger.info(
            f"[get_members] Query params: resource_type_variants={resource_type_variants}, "
            f"resource_id={resource_id}, status={MemberStatus.APPROVED.value}"
        )
        logger.info(
            f"[get_members] Found {len(all_members)} raw members, {len(members)} after deduplication"
        )
        for member in members:
            logger.info(
                f"[get_members] Member detail: id={member.id}, resource_type={member.resource_type}, "
                f"resource_id={member.resource_id}, user_id={member.user_id}"
            )

        # Populate user names
        user_ids = set()
        for m in members:
            user_ids.add(m.user_id)
            if m.invited_by_user_id:
                user_ids.add(m.invited_by_user_id)
            if m.reviewed_by_user_id:
                user_ids.add(m.reviewed_by_user_id)

        users = db.query(User).filter(User.id.in_(user_ids)).all()
        user_map = {u.id: u for u in users}

        member_responses = [self._member_to_response(m, user_map) for m in members]

        return MemberListResponse(members=member_responses, total=len(member_responses))

    def add_member(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        target_user_id: int,
        permission_level: SchemaPermissionLevel,
    ) -> ResourceMemberResponse:
        """Directly add a member to a resource."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, current_user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, current_user_id, SchemaPermissionLevel.MANAGE
        )

        if owner_id != current_user_id and not has_manage:
            raise HTTPException(status_code=403, detail="No permission to add members")

        # Cannot add self
        if target_user_id == current_user_id:
            raise HTTPException(status_code=400, detail="Cannot add yourself")

        # Check target user exists
        target_user = (
            db.query(User)
            .filter(User.id == target_user_id, User.is_active == True)
            .first()
        )
        if not target_user:
            raise HTTPException(status_code=404, detail="Target user not found")

        # LOGGING: Log user information to verify email is available in User model
        logger.info(
            f"[add_member] Target user found: user_id={target_user_id}, "
            f"user_name={target_user.user_name}, email={target_user.email}"
        )

        # Check for existing member
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        # We need to check both formats to handle legacy data and prevent duplicate records
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        existing = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.user_id == target_user_id,
            )
            .first()
        )

        if existing:
            # Note: Database may store status in different formats (e.g., "APPROVED" vs "approved")
            if existing.status.lower() == MemberStatus.APPROVED.value.lower():
                raise HTTPException(status_code=400, detail="User already has access")

            # Ensure share_link_id is set (required by database)
            if not existing.share_link_id:
                # Note: Database may store resource_type in different formats
                resource_type_variants = [self.resource_type.value]
                if self.resource_type.value == "KnowledgeBase":
                    resource_type_variants.append("KNOWLEDGE_BASE")

                share_link = (
                    db.query(ShareLink)
                    .filter(
                        ShareLink.resource_type.in_(resource_type_variants),
                        ShareLink.resource_id == resource_id,
                        ShareLink.is_active == True,
                    )
                    .first()
                )
                if not share_link:
                    share_token = self._generate_share_token(
                        current_user_id, resource_id
                    )
                    share_link = ShareLink(
                        resource_type=self.resource_type.value,
                        resource_id=resource_id,
                        share_token=share_token,
                        require_approval=True,
                        default_permission_level=PermissionLevel.VIEW.value,
                        expires_at=datetime.utcnow() + timedelta(days=365 * 100),
                        created_by_user_id=current_user_id,
                        is_active=True,
                    )
                    db.add(share_link)
                    db.flush()
                existing.share_link_id = share_link.id

            # Update existing record
            existing.permission_level = permission_level.value
            existing.status = MemberStatus.APPROVED.value
            existing.invited_by_user_id = current_user_id
            existing.reviewed_by_user_id = current_user_id
            existing.reviewed_at = datetime.utcnow()
            existing.updated_at = datetime.utcnow()
            member = existing
        else:
            # Get or create a share link for direct member addition
            # This is needed because share_link_id may be required in the database
            # Note: Database may store resource_type in different formats
            resource_type_variants = [self.resource_type.value]
            if self.resource_type.value == "KnowledgeBase":
                resource_type_variants.append("KNOWLEDGE_BASE")

            share_link = (
                db.query(ShareLink)
                .filter(
                    ShareLink.resource_type.in_(resource_type_variants),
                    ShareLink.resource_id == resource_id,
                    ShareLink.is_active == True,
                )
                .first()
            )

            # If no share link exists, create one for tracking purposes
            if not share_link:
                share_token = self._generate_share_token(current_user_id, resource_id)
                share_link = ShareLink(
                    resource_type=self.resource_type.value,
                    resource_id=resource_id,
                    share_token=share_token,
                    require_approval=True,
                    default_permission_level=PermissionLevel.VIEW.value,
                    expires_at=datetime.utcnow() + timedelta(days=365 * 100),
                    created_by_user_id=current_user_id,
                    is_active=True,
                )
                db.add(share_link)
                db.flush()  # Get the share_link.id

            # Create new member with approved status
            member = ResourceMember(
                resource_type=self.resource_type.value,
                resource_id=resource_id,
                user_id=target_user_id,
                permission_level=permission_level.value,
                status=MemberStatus.APPROVED.value,
                invited_by_user_id=current_user_id,
                share_link_id=share_link.id,
                reviewed_by_user_id=current_user_id,
                reviewed_at=datetime.utcnow(),
            )
            db.add(member)

        db.commit()
        db.refresh(member)

        # Call approval hook
        copied_resource_id = self._on_member_approved(db, member, resource)
        if copied_resource_id:
            member.copied_resource_id = copied_resource_id
            db.commit()

        # Get user names for response
        users = (
            db.query(User).filter(User.id.in_([target_user_id, current_user_id])).all()
        )
        # LOGGING: Verify user_map contains email field
        user_map = {u.id: u for u in users}
        logger.info(f"[add_member] User map created with {len(user_map)} users")

        return self._member_to_response(member, user_map)

    def update_member(
        self,
        db: Session,
        resource_id: int,
        member_id: int,
        current_user_id: int,
        permission_level: SchemaPermissionLevel,
    ) -> ResourceMemberResponse:
        """Update a member's permission level."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, current_user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, current_user_id, SchemaPermissionLevel.MANAGE
        )

        if owner_id != current_user_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to update members"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Find member
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.id == member_id,
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=404, detail="Member not found")

        # Update permission
        member.permission_level = permission_level.value
        member.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(member)

        # Get user names
        user_ids = {member.user_id}
        if member.invited_by_user_id:
            user_ids.add(member.invited_by_user_id)
        if member.reviewed_by_user_id:
            user_ids.add(member.reviewed_by_user_id)

        users = db.query(User).filter(User.id.in_(user_ids)).all()
        user_map = {u.id: u for u in users}

        return self._member_to_response(member, user_map)

    def remove_member(
        self,
        db: Session,
        resource_id: int,
        member_id: int,
        current_user_id: int,
    ) -> bool:
        """Remove a member from a resource."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, current_user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, current_user_id, SchemaPermissionLevel.MANAGE
        )

        if owner_id != current_user_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to remove members"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Find member
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.id == member_id,
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=404, detail="Member not found")

        # Delete member record
        db.delete(member)
        db.commit()

        return True

    def _member_to_response(
        self, member: ResourceMember, user_map: Dict[int, User]
    ) -> ResourceMemberResponse:
        """Convert ResourceMember model to response schema."""
        # Get user name and email from map
        user = user_map.get(member.user_id)
        user_name = user.user_name if user else None
        user_email = user.email if user else None

        # Get invited by user name
        invited_by_user = user_map.get(member.invited_by_user_id)
        invited_by_user_name = invited_by_user.user_name if invited_by_user else None

        # Get reviewed by user name
        reviewed_by_user_name = None
        if member.reviewed_by_user_id:
            reviewed_by_user = user_map.get(member.reviewed_by_user_id)
            reviewed_by_user_name = (
                reviewed_by_user.user_name if reviewed_by_user else None
            )

        return ResourceMemberResponse(
            id=member.id,
            resource_type=member.resource_type,
            resource_id=member.resource_id,
            user_id=member.user_id,
            user_name=user_name,
            user_email=user_email,
            permission_level=member.permission_level,
            status=member.status,
            invited_by_user_id=member.invited_by_user_id,
            invited_by_user_name=invited_by_user_name,
            reviewed_by_user_id=member.reviewed_by_user_id,
            reviewed_by_user_name=reviewed_by_user_name,
            reviewed_at=member.reviewed_at,
            copied_resource_id=member.copied_resource_id,
            requested_at=member.requested_at,
            created_at=member.created_at,
            updated_at=member.updated_at,
        )

    # =========================================================================
    # Approval Operations
    # =========================================================================

    def get_pending_requests(
        self, db: Session, resource_id: int, user_id: int
    ) -> PendingRequestListResponse:
        """Get pending approval requests for a resource."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, user_id, SchemaPermissionLevel.MANAGE
        )

        if owner_id != user_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to view pending requests"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        # We need to query both formats to handle legacy data
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Note: Database may store status in different formats (e.g., "PENDING" vs "pending")
        pending_status_variants = [
            MemberStatus.PENDING.value,
            MemberStatus.PENDING.value.upper(),
        ]

        # Get pending members
        pending_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.status.in_(pending_status_variants),
            )
            .all()
        )

        # Get user names
        user_ids = {m.user_id for m in pending_members}
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        user_map = {u.id: u for u in users}

        requests = [
            PendingRequestResponse(
                id=m.id,
                user_id=m.user_id,
                user_name=(
                    user_map.get(m.user_id).user_name
                    if user_map.get(m.user_id)
                    else None
                ),
                user_email=(
                    user_map.get(m.user_id).email if user_map.get(m.user_id) else None
                ),
                requested_permission_level=m.permission_level,
                requested_at=m.requested_at,
            )
            for m in pending_members
        ]

        return PendingRequestListResponse(requests=requests, total=len(requests))

    def review_request(
        self,
        db: Session,
        resource_id: int,
        request_id: int,
        reviewer_id: int,
        approved: bool,
        permission_level: Optional[SchemaPermissionLevel] = None,
    ) -> ReviewRequestResponse:
        """Review (approve/reject) a pending request."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, reviewer_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, reviewer_id, SchemaPermissionLevel.MANAGE
        )

        if owner_id != reviewer_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to review requests"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Note: Database may store status in different formats (e.g., "PENDING" vs "pending")
        pending_status_variants = [
            MemberStatus.PENDING.value,
            MemberStatus.PENDING.value.upper(),
        ]

        # Find pending member
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.id == request_id,
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.status.in_(pending_status_variants),
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=404, detail="Pending request not found")

        # Update status
        if approved:
            member.status = MemberStatus.APPROVED.value
            if permission_level:
                member.permission_level = permission_level.value
        else:
            member.status = MemberStatus.REJECTED.value

        member.reviewed_by_user_id = reviewer_id
        member.reviewed_at = datetime.utcnow()
        member.updated_at = datetime.utcnow()

        db.commit()
        db.refresh(member)

        # If approved, call the approval hook
        if approved:
            copied_resource_id = self._on_member_approved(db, member, resource)
            if copied_resource_id:
                member.copied_resource_id = copied_resource_id
                db.commit()

        return ReviewRequestResponse(
            message="Request approved" if approved else "Request rejected",
            member_id=member.id,
            new_status=SchemaMemberStatus(member.status),
            permission_level=member.permission_level if approved else None,
        )

    # =========================================================================
    # Permission Checking
    # =========================================================================

    def check_permission(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
        required_level: SchemaPermissionLevel,
    ) -> bool:
        """
        Check if user has required permission level.

        Permission hierarchy: manage > edit > view
        """
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Note: Database may store status in different formats (e.g., "APPROVED" vs "approved")
        approved_status_variants = [
            MemberStatus.APPROVED.value,
            MemberStatus.APPROVED.value.upper(),
        ]

        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.user_id == user_id,
                ResourceMember.status.in_(approved_status_variants),
            )
            .first()
        )

        if not member:
            return False

        actual_level = self.PERMISSION_HIERARCHY.get(member.permission_level, 0)
        required = self.PERMISSION_HIERARCHY.get(required_level.value, 0)

        return actual_level >= required

    def get_user_permission_level(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[str]:
        """Get user's permission level for a resource."""
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Note: Database may store status in different formats (e.g., "APPROVED" vs "approved")
        approved_status_variants = [
            MemberStatus.APPROVED.value,
            MemberStatus.APPROVED.value.upper(),
        ]

        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.user_id == user_id,
                ResourceMember.status.in_(approved_status_variants),
            )
            .first()
        )

        return member.permission_level if member else None
