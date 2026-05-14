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
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType, ShareLink
from app.models.user import User
from app.schemas.base_role import BaseRole, get_highest_role, has_permission
from app.schemas.share import (
    BatchResourceMemberResponse,
    FailedMemberResponse,
    JoinByLinkResponse,
    MemberListResponse,
)
from app.schemas.share import MemberStatus as SchemaMemberStatus
from app.schemas.share import (
    MyPermissionSourcesResponse,
    PendingRequestListResponse,
    PendingRequestResponse,
    PermissionSourceInfo,
    ResourceMemberResponse,
    ReviewRequestResponse,
    ShareInfoResponse,
    ShareLinkConfig,
    ShareLinkResponse,
)
from app.services.share.external_entity_resolver import get_entity_resolver
from shared.telemetry.decorators import trace_sync

# SchemaMemberRole is an alias to BaseRole for backward compatibility
# All role-related code should use BaseRole as the single source of truth
SchemaMemberRole = BaseRole

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

    def __init__(self, resource_type: ResourceType):
        """Initialize the share service for a specific resource type."""
        self.resource_type = resource_type
        self.aes_key = settings.SHARE_TOKEN_AES_KEY.encode("utf-8")
        self.aes_iv = settings.SHARE_TOKEN_AES_IV.encode("utf-8")

    @property
    def _resource_type_variants(self) -> list[str]:
        """Return resource_type values to query, handling legacy formats."""
        variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            variants.append("KNOWLEDGE_BASE")
        return variants

    @property
    def _approved_status_variants(self) -> list[str]:
        """Return approved status values to query, handling legacy case formats."""
        return [
            MemberStatus.APPROVED.value,
            MemberStatus.APPROVED.value.upper(),
        ]

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
        resource_type_variants = self._resource_type_variants

        # _resource_type_variants already handles KnowledgeBase -> KNOWLEDGE_BASE

        existing_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active.is_(True),
            )
            .first()
        )

        logger.info(
            f"[create_share_link] Existing link check: "
            f"found={existing_link is not None}, "
            f"existing_link_id={existing_link.id if existing_link else None}"
        )

        if existing_link:
            # Update existing link
            logger.info(
                f"[create_share_link] UPDATING existing link: id={existing_link.id}"
            )
            existing_link.require_approval = config.require_approval
            existing_link.default_role = config.default_role.value
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
            default_role=config.default_role.value,
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
        resource_type_variants = self._resource_type_variants

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active.is_(True),
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
        resource_type_variants = self._resource_type_variants

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active.is_(True),
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
        # Get default_role from the model
        default_role = getattr(share_link, "default_role", None)
        if not default_role:
            default_role = ResourceRole.Reporter.value

        return ShareLinkResponse(
            id=share_link.id,
            resource_type=share_link.resource_type,
            resource_id=share_link.resource_id,
            share_url=self._generate_share_url(share_link.share_token),
            share_token=share_link.share_token,
            require_approval=share_link.require_approval,
            default_role=default_role,
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
        resource_type_variants = self._resource_type_variants

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active.is_(True),
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
            db.query(User).filter(User.id == owner_id, User.is_active.is_(True)).first()
        )
        owner_name = owner.user_name if owner else f"User_{owner_id}"

        # Get default_role from the model
        default_role = getattr(share_link, "default_role", None)
        if not default_role:
            default_role = ResourceRole.Reporter.value

        return ShareInfoResponse(
            resource_type=self.resource_type.value,
            resource_id=resource_id,
            resource_name=self._get_resource_name(resource),
            owner_user_id=owner_id,
            owner_user_name=owner_name,
            require_approval=share_link.require_approval,
            default_role=default_role,
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
        requested_role: Optional[SchemaMemberRole] = None,
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
        resource_type_variants = self._resource_type_variants

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active.is_(True),
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
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
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
            # Determine role from share link default_role or requested_role
            default_role = getattr(share_link, "default_role", None)
            if not default_role:
                default_role = ResourceRole.Reporter.value

            # Use requested role if provided and approval is required, otherwise use default
            role = (
                requested_role.value if is_pending and requested_role else default_role
            )

            # Security guard: Never grant Owner role via share link join
            if role == ResourceRole.Owner.value:
                role = ResourceRole.Reporter.value

            existing_member.set_role(role)
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

            # Determine role from share link default_role or requested_role
            default_role = getattr(share_link, "default_role", None)
            if not default_role:
                default_role = ResourceRole.Reporter.value

            # Use requested role if provided and approval is required, otherwise use default
            role = (
                requested_role.value if is_pending and requested_role else default_role
            )

            # Security guard: Never grant Owner role via share link join
            if role == ResourceRole.Owner.value:
                role = ResourceRole.Reporter.value

            # Create member record
            # For PENDING status, use 0 as placeholder for reviewed_by_user_id
            # For APPROVED (auto-approved), use owner_id
            member = ResourceMember.create(
                resource_type=self.resource_type.value,
                resource_id=resource_id,
                entity_type="user",
                entity_id=str(user_id),
                role=role,
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
        resource_type_variants = self._resource_type_variants
        approved_status_variants = self._approved_status_variants

        all_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.status.in_(approved_status_variants),
            )
            .all()
        )

        # Deduplicate members by user_id (for user-type) or (entity_type, entity_id)
        # This handles legacy data where the same user may have multiple records.
        # Approved records take precedence over pending ones.
        member_by_key: dict = {}
        for member in all_members:
            if member.entity_type and member.entity_type != "user" and member.entity_id:
                key = (member.entity_type, member.entity_id)
            else:
                key = member.user_id

            existing = member_by_key.get(key)
            if not existing or member.status == MemberStatus.APPROVED.value:
                member_by_key[key] = member

        members = list(member_by_key.values())

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

        # Batch-preload namespace display names for entity-type members
        namespace_ids = set()
        # Collect external entity IDs by type for batch resolution
        external_entity_ids: dict[str, set[str]] = {}
        for m in members:
            if m.entity_type and m.entity_type != "user" and m.entity_id:
                if m.entity_type == "namespace":
                    try:
                        namespace_ids.add(int(m.entity_id))
                    except (ValueError, TypeError):
                        pass
                else:
                    external_entity_ids.setdefault(m.entity_type, set()).add(
                        m.entity_id
                    )

        namespace_map = {}
        if namespace_ids:
            namespaces = (
                db.query(Namespace.id, Namespace.display_name, Namespace.name)
                .filter(Namespace.id.in_(namespace_ids))
                .all()
            )
            namespace_map = {ns.id: (ns.display_name or ns.name) for ns in namespaces}

        # Batch resolve external entity display names
        external_display_names: dict[str, dict[str, str]] = {}
        if external_entity_ids:
            for entity_type, entity_ids in external_entity_ids.items():
                resolver = get_entity_resolver(entity_type)
                if not resolver:
                    continue
                external_display_names[entity_type] = resolver.batch_get_display_names(
                    db, list(entity_ids)
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

        member_responses = [
            self._member_to_response(
                m,
                user_map,
                db=db,
                namespace_map=namespace_map,
                external_display_names=external_display_names,
            )
            for m in members
        ]

        return MemberListResponse(members=member_responses, total=len(member_responses))

    def add_member(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        target_user_id: int,
        role: SchemaMemberRole,
        entity_type: Optional[str] = None,
        entity_id: Optional[str] = None,
        entity_display_name: Optional[str] = None,
    ) -> ResourceMemberResponse:
        """Directly add a member to a resource."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, current_user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, current_user_id, SchemaMemberRole.Maintainer
        )

        if owner_id != current_user_id and not has_manage:
            raise HTTPException(status_code=403, detail="No permission to add members")

        # Cannot add self
        if target_user_id == current_user_id and not entity_type:
            raise HTTPException(status_code=400, detail="Cannot add yourself")

        # Determine effective entity type
        eff_entity_type = entity_type if entity_type else "user"
        eff_entity_id = entity_id if entity_id else str(target_user_id)

        # Validate entity_type if non-user and non-built-in
        # Built-in types: 'user' (default) and 'namespace' (handled natively)
        if eff_entity_type not in ("user", "namespace") and not get_entity_resolver(
            eff_entity_type
        ):
            raise HTTPException(
                status_code=400, detail=f"Unknown entity type: {eff_entity_type}"
            )

        # Suppress display-name snapshots for reliably resolvable entity types.
        # User and namespace names can always be resolved from local DB tables;
        # only external/unreliable types (registered via register_entity_resolver)
        # need snapshots.
        needs_snapshot = True
        if eff_entity_type == "user":
            needs_snapshot = False
        else:
            resolver = get_entity_resolver(eff_entity_type)
            if resolver and not resolver.requires_display_name_snapshot:
                needs_snapshot = False
        if not needs_snapshot:
            entity_display_name = None
        elif not entity_display_name:
            # Auto-fill snapshot for external types that require it
            resolver = get_entity_resolver(eff_entity_type)
            if resolver:
                entity_display_name = resolver.get_display_name(db, eff_entity_id)

        # Check target user exists (only for user-type members)
        if eff_entity_type == "user":
            target_user = (
                db.query(User)
                .filter(User.id == target_user_id, User.is_active.is_(True))
                .first()
            )
            if not target_user:
                raise HTTPException(status_code=404, detail="Target user not found")
        else:
            target_user = None

        # LOGGING: Log user information to verify email is available in User model
        if target_user:
            logger.info(
                f"[add_member] Target user found: user_id={target_user_id}, "
                f"user_name={target_user.user_name}"
            )

        # Check for existing member by entity
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

        existing = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type == eff_entity_type,
                ResourceMember.entity_id == eff_entity_id,
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
                resource_type_variants = self._resource_type_variants

                share_link = (
                    db.query(ShareLink)
                    .filter(
                        ShareLink.resource_type.in_(resource_type_variants),
                        ShareLink.resource_id == resource_id,
                        ShareLink.is_active.is_(True),
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
                        default_role=ResourceRole.Reporter.value,
                        expires_at=datetime.utcnow() + timedelta(days=365 * 100),
                        created_by_user_id=current_user_id,
                        is_active=True,
                    )
                    db.add(share_link)
                    db.flush()
                existing.share_link_id = share_link.id

            # Update existing record
            existing.set_role(role.value)
            existing.status = MemberStatus.APPROVED.value
            existing.invited_by_user_id = current_user_id
            existing.reviewed_by_user_id = current_user_id
            existing.reviewed_at = datetime.utcnow()
            existing.updated_at = datetime.utcnow()
            if entity_display_name is not None:
                existing.entity_display_name = entity_display_name
            member = existing
        else:
            # Get or create a share link for direct member addition
            # This is needed because share_link_id may be required in the database
            # Note: Database may store resource_type in different formats
            resource_type_variants = self._resource_type_variants

            share_link = (
                db.query(ShareLink)
                .filter(
                    ShareLink.resource_type.in_(resource_type_variants),
                    ShareLink.resource_id == resource_id,
                    ShareLink.is_active.is_(True),
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
                    default_role=ResourceRole.Reporter.value,
                    expires_at=datetime.utcnow() + timedelta(days=365 * 100),
                    created_by_user_id=current_user_id,
                    is_active=True,
                )
                db.add(share_link)
                db.flush()  # Get the share_link.id

            # Create new member with approved status
            member = ResourceMember.create(
                resource_type=self.resource_type.value,
                resource_id=resource_id,
                entity_type=eff_entity_type,
                entity_id=eff_entity_id,
                role=role.value,
                status=MemberStatus.APPROVED.value,
                invited_by_user_id=current_user_id,
                share_link_id=share_link.id,
                reviewed_by_user_id=current_user_id,
                reviewed_at=datetime.utcnow(),
                entity_display_name=entity_display_name,
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

        return self._member_to_response(member, user_map, db=db)

    @trace_sync(
        span_name="share.batch_add_members",
        tracer_name="backend.services.share",
        extract_attributes=lambda self, db, resource_id, current_user_id, members_data: {
            "resource_id": resource_id,
            "current_user_id": current_user_id,
            "members_count": len(members_data),
        },
    )
    def batch_add_members(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        members_data: List[
            Tuple[int, SchemaMemberRole, Optional[str], Optional[str], Optional[str]]
        ],
    ) -> BatchResourceMemberResponse:
        """Batch add multiple members to a resource in a single transaction.

        Args:
            db: Database session
            resource_id: Resource ID
            current_user_id: Current user performing the action
            members_data: List of (target_user_id, role, entity_type, entity_id, entity_display_name) tuples.
                For user-type members: (target_user_id, role, None, None, None)
                For entity-type members: (0, role, entity_type, entity_id, entity_display_name)
        """
        # Validate resource and ownership/manage permission once
        resource = self._get_resource(db, resource_id, current_user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, current_user_id, SchemaMemberRole.Maintainer
        )
        if owner_id != current_user_id and not has_manage:
            raise HTTPException(status_code=403, detail="No permission to add members")

        # Get or create share link once for all members
        resource_type_variants = self._resource_type_variants

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active.is_(True),
            )
            .first()
        )
        if not share_link:
            share_token = self._generate_share_token(current_user_id, resource_id)
            share_link = ShareLink(
                resource_type=self.resource_type.value,
                resource_id=resource_id,
                share_token=share_token,
                require_approval=True,
                default_role=ResourceRole.Reporter.value,
                expires_at=datetime.utcnow() + timedelta(days=365 * 100),
                created_by_user_id=current_user_id,
                is_active=True,
            )
            db.add(share_link)
            db.flush()

        # Separate user-type and entity-type members
        user_member_entries: List[Tuple[int, SchemaMemberRole]] = []
        entity_member_entries: List[
            Tuple[str, str, SchemaMemberRole, Optional[str]]
        ] = []
        for entry in members_data:
            target_user_id, role, entity_type, entity_id, entity_display_name = entry
            if entity_type and entity_type != "user":
                eff_entity_type = entity_type
                eff_entity_id = entity_id if entity_id else str(target_user_id)
                # Validate entity_type if non-user and non-built-in
                resolver = get_entity_resolver(eff_entity_type)
                if eff_entity_type not in ("user", "namespace") and not resolver:
                    failed.append(
                        FailedMemberResponse(
                            user_id=0,
                            entity_type=eff_entity_type,
                            entity_id=eff_entity_id,
                            error=f"Unknown entity type: {eff_entity_type}",
                        )
                    )
                    continue
                # Suppress snapshots for reliably resolvable entity types
                needs_snapshot = True
                if not resolver.requires_display_name_snapshot:
                    needs_snapshot = False
                if not needs_snapshot:
                    entity_display_name = None
                elif not entity_display_name:
                    # Auto-fill snapshot for external types that require it
                    entity_display_name = resolver.get_display_name(db, eff_entity_id)
                entity_member_entries.append(
                    (eff_entity_type, eff_entity_id, role, entity_display_name)
                )
            else:
                user_member_entries.append((target_user_id, role))

        # Batch-query all target users for user-type members
        target_user_ids = [uid for uid, _ in user_member_entries]
        target_users = (
            (
                db.query(User)
                .filter(User.id.in_(target_user_ids), User.is_active.is_(True))
                .all()
            )
            if target_user_ids
            else []
        )
        valid_user_map = {u.id: u for u in target_users}

        # Query existing user-type members
        user_existing_members = (
            (
                db.query(ResourceMember)
                .filter(
                    ResourceMember.resource_type.in_(resource_type_variants),
                    ResourceMember.resource_id == resource_id,
                    ResourceMember.entity_type == "user",
                    ResourceMember.entity_id.in_([str(uid) for uid in target_user_ids]),
                )
                .all()
            )
            if target_user_ids
            else []
        )
        user_existing_map = {m.user_id: m for m in user_existing_members}

        # Query existing entity-type members
        entity_keys = [(et, eid) for et, eid, _, _ in entity_member_entries]
        entity_existing_members = []
        if entity_keys:
            from sqlalchemy import and_, or_

            entity_filters = [
                and_(
                    ResourceMember.entity_type == et,
                    ResourceMember.entity_id == eid,
                )
                for et, eid in entity_keys
            ]
            entity_existing_members = (
                db.query(ResourceMember)
                .filter(
                    ResourceMember.resource_type.in_(resource_type_variants),
                    ResourceMember.resource_id == resource_id,
                    or_(*entity_filters),
                )
                .all()
            )
        entity_existing_map = {
            (m.entity_type, m.entity_id): m for m in entity_existing_members
        }

        succeeded: List[ResourceMember] = []
        failed: List[FailedMemberResponse] = []
        # Track processed entity keys to guard against duplicates within members_data
        processed_user_ids: set = set()
        processed_entity_keys: set = set()

        # Process user-type members
        for target_user_id, role in user_member_entries:
            # Skip self-add
            if target_user_id == current_user_id:
                failed.append(
                    FailedMemberResponse(
                        user_id=target_user_id, error="Cannot add yourself"
                    )
                )
                continue

            # Skip duplicate entries within the same batch request
            if target_user_id in processed_user_ids:
                failed.append(
                    FailedMemberResponse(
                        user_id=target_user_id,
                        error="Duplicate entry in request",
                    )
                )
                continue

            # Check user exists
            if target_user_id not in valid_user_map:
                failed.append(
                    FailedMemberResponse(
                        user_id=target_user_id, error="User not found or inactive"
                    )
                )
                continue

            existing = user_existing_map.get(target_user_id)
            if existing:
                if existing.status.lower() == MemberStatus.APPROVED.value.lower():
                    failed.append(
                        FailedMemberResponse(
                            user_id=target_user_id,
                            error="User already has access",
                        )
                    )
                    continue

                # Update existing pending/rejected record
                if not existing.share_link_id:
                    existing.share_link_id = share_link.id
                existing.set_role(role.value)
                existing.status = MemberStatus.APPROVED.value
                existing.invited_by_user_id = current_user_id
                existing.reviewed_by_user_id = current_user_id
                existing.reviewed_at = datetime.utcnow()
                existing.updated_at = datetime.utcnow()
                succeeded.append(existing)
                processed_user_ids.add(target_user_id)
            else:
                # Create new member
                member = ResourceMember.create(
                    resource_type=self.resource_type.value,
                    resource_id=resource_id,
                    entity_type="user",
                    entity_id=str(target_user_id),
                    role=role.value,
                    status=MemberStatus.APPROVED.value,
                    invited_by_user_id=current_user_id,
                    share_link_id=share_link.id,
                    reviewed_by_user_id=current_user_id,
                    reviewed_at=datetime.utcnow(),
                )
                db.add(member)
                succeeded.append(member)
                user_existing_map[target_user_id] = member
                processed_user_ids.add(target_user_id)

        # Process entity-type members
        for (
            entity_type_str,
            entity_id_str,
            role,
            entity_display_name,
        ) in entity_member_entries:
            entity_key = (entity_type_str, entity_id_str)

            # Skip duplicate entries within the same batch request
            if entity_key in processed_entity_keys:
                failed.append(
                    FailedMemberResponse(
                        user_id=0,
                        entity_type=entity_type_str,
                        entity_id=entity_id_str,
                        error="Duplicate entry in request",
                    )
                )
                continue

            existing = entity_existing_map.get(entity_key)
            if existing:
                if existing.status.lower() == MemberStatus.APPROVED.value.lower():
                    failed.append(
                        FailedMemberResponse(
                            user_id=0,
                            entity_type=entity_type_str,
                            entity_id=entity_id_str,
                            error="Entity already has access",
                        )
                    )
                    continue

                # Update existing pending/rejected record
                if not existing.share_link_id:
                    existing.share_link_id = share_link.id
                existing.set_role(role.value)
                existing.status = MemberStatus.APPROVED.value
                existing.invited_by_user_id = current_user_id
                existing.reviewed_by_user_id = current_user_id
                existing.reviewed_at = datetime.utcnow()
                existing.updated_at = datetime.utcnow()
                if entity_display_name is not None:
                    existing.entity_display_name = entity_display_name
                succeeded.append(existing)
                processed_entity_keys.add(entity_key)
            else:
                # Create new entity member
                member = ResourceMember.create(
                    resource_type=self.resource_type.value,
                    resource_id=resource_id,
                    entity_type=entity_type_str,
                    entity_id=entity_id_str,
                    role=role.value,
                    status=MemberStatus.APPROVED.value,
                    invited_by_user_id=current_user_id,
                    share_link_id=share_link.id,
                    reviewed_by_user_id=current_user_id,
                    reviewed_at=datetime.utcnow(),
                    entity_display_name=entity_display_name,
                )
                db.add(member)
                succeeded.append(member)
                entity_existing_map[entity_key] = member
                processed_entity_keys.add(entity_key)

        db.commit()

        # Refresh all succeeded members, then call approval hooks and collect
        # copied_resource_id values in-memory before a single final commit.
        for member in succeeded:
            db.refresh(member)

        for member in succeeded:
            try:
                copied_resource_id = self._on_member_approved(db, member, resource)
                if copied_resource_id:
                    member.copied_resource_id = copied_resource_id
            except Exception as exc:
                logger.error(
                    "Approval hook failed for member %s: %s",
                    member.user_id,
                    exc,
                )

        # Persist all copied_resource_id updates in one commit
        db.commit()

        # Build user map for responses (only for user-type members)
        all_user_ids = set(target_user_ids) | {current_user_id}
        all_users = db.query(User).filter(User.id.in_(all_user_ids)).all()
        user_map = {u.id: u for u in all_users}

        return BatchResourceMemberResponse(
            succeeded=[self._member_to_response(m, user_map, db=db) for m in succeeded],
            failed=failed,
        )

    def update_member(
        self,
        db: Session,
        resource_id: int,
        member_id: int,
        current_user_id: int,
        role: SchemaMemberRole,
    ) -> ResourceMemberResponse:
        """Update a member's role."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, current_user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, current_user_id, SchemaMemberRole.Maintainer
        )

        if owner_id != current_user_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to update members"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

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

        # Update role
        member.set_role(role.value)
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

        return self._member_to_response(member, user_map, db=db)

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
            db, resource_id, current_user_id, SchemaMemberRole.Maintainer
        )

        if owner_id != current_user_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to remove members"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

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

        # Prevent non-owners from removing the owner
        if member.get_effective_role() == ResourceRole.Owner.value:
            if current_user_id != owner_id:
                raise HTTPException(status_code=403, detail="Cannot remove the owner")

        # Prevent self-removal via this endpoint (should use leave)
        if member.entity_type == "user" and member.entity_id == str(current_user_id):
            raise HTTPException(
                status_code=400, detail="Use leave instead of removing yourself"
            )

        # Prevent self-demotion: if removing this entity member would cause the
        # current user to lose their management permission, reject. Owners are
        # always exempt since their role is not revoked by member deletion.
        if current_user_id != owner_id and self._remove_would_lose_manage(
            db, resource_id, current_user_id, member
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Cannot remove this member: you would lose your own "
                    "management permission"
                ),
            )

        # Delete member record
        db.delete(member)
        db.commit()

        return True

    def _remove_would_lose_manage(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
        member_to_remove: ResourceMember,
    ) -> bool:
        """Check whether removing a member would drop the given user below Maintainer.

        Looks at all remaining approved member records for the resource (excluding
        the one being removed) and recomputes the user's effective role: direct
        user-type record first, then highest entity-type role matched via resolvers.
        Returns True if none of them grant Maintainer or higher.
        """
        resource_type_variants = self._resource_type_variants
        approved_status_variants = self._approved_status_variants

        # Direct user-type membership still grants manage?
        direct_member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(approved_status_variants),
                ResourceMember.id != member_to_remove.id,
            )
            .first()
        )
        if direct_member and has_permission(
            direct_member.get_effective_role(),
            SchemaMemberRole.Maintainer.value,
        ):
            return False

        # Any remaining entity-type binding that matches the user grants manage?
        entity_rows = (
            db.query(
                ResourceMember.entity_type,
                ResourceMember.entity_id,
                ResourceMember.role,
            )
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type != "user",
                ResourceMember.entity_type != "",
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status.in_(approved_status_variants),
                ResourceMember.id != member_to_remove.id,
            )
            .all()
        )

        from collections import defaultdict

        entity_groups: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)
        for et, eid, role in entity_rows:
            if et and eid:
                entity_groups[et].append((eid, role))

        for entity_type_str, entries in entity_groups.items():
            resolver = get_entity_resolver(entity_type_str)
            if not resolver:
                continue
            eids = [eid for eid, _ in entries]
            matched = resolver.match_entity_bindings(db, user_id, entity_type_str, eids)
            if not matched:
                continue
            role_by_eid = {eid: role for eid, role in entries}
            for eid in matched:
                role = role_by_eid.get(eid)
                if role and has_permission(role, SchemaMemberRole.Maintainer.value):
                    return False

        return True

    def _resolve_source_type(self, member: ResourceMember) -> str:
        """
        Determine the source type of a member permission.

        Returns:
            'direct' — user was directly added as a member
            'entity_permission' — group/entity was authorized
            'share_link' — user joined via share link
        """
        if member.entity_type and member.entity_type != "user":
            return "entity_permission"
        if (
            member.share_link_id
            and member.share_link_id > 0
            and member.invited_by_user_id == 0
        ):
            return "share_link"
        return "direct"

    def _get_entity_display_name(
        self,
        db: Session,
        entity_type: str,
        entity_id: str,
        namespace_map: Optional[dict[int, str]] = None,
        external_display_names: Optional[dict[str, dict[str, str]]] = None,
    ) -> Optional[str]:
        """
        Resolve display name for entity-type members.

        Built-in support for 'namespace' (group) entities with optional
        batch-preloaded namespace_map for performance.
        Subclasses can override to support additional entity types.

        Args:
            db: Database session
            entity_type: Entity type (e.g., 'namespace')
            entity_id: Entity identifier
            namespace_map: Optional preloaded dict of namespace_id -> display_name
            external_display_names: Optional preloaded dict of
                entity_type -> {entity_id -> display_name}

        Returns:
            Display name string or None if not resolvable
        """
        if entity_type == "namespace":
            try:
                ns_id = int(entity_id)
            except (ValueError, TypeError):
                return None
            if namespace_map is not None:
                return namespace_map.get(ns_id)
            namespace = db.query(Namespace).filter(Namespace.id == ns_id).first()
            if namespace:
                return namespace.display_name or namespace.name
            return None

        if external_display_names is not None:
            cached = external_display_names.get(entity_type, {}).get(entity_id)
            if cached:
                return cached

        # Try external resolvers for display name
        resolver = get_entity_resolver(entity_type)
        if resolver:
            display_name = resolver.get_display_name(db, entity_id)
            if display_name:
                return display_name

        return None

    def _member_to_response(
        self,
        member: ResourceMember,
        user_map: Dict[int, User],
        db: Session = None,
        namespace_map: Optional[dict[int, str]] = None,
        external_display_names: Optional[dict[str, dict[str, str]]] = None,
    ) -> ResourceMemberResponse:
        """Convert ResourceMember model to response schema."""
        # Get user name and email from map
        user = user_map.get(member.user_id)
        user_email = user.email if user else None

        # Determine unified display_name based on member type
        display_name = None
        if member.entity_type and member.entity_type != "user":
            # Entity-type member — prefer persisted snapshot for unreliable
            # types, then live lookup via _get_entity_display_name.
            if member.entity_display_name:
                display_name = member.entity_display_name
            elif member.entity_id and db:
                display_name = self._get_entity_display_name(
                    db,
                    member.entity_type,
                    member.entity_id,
                    namespace_map,
                    external_display_names,
                )
        elif user:
            # User-type member — use user name
            display_name = user.user_name

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

        # Get effective role for response
        effective_role = member.get_effective_role()
        source_type = self._resolve_source_type(member)

        return ResourceMemberResponse(
            id=member.id,
            resource_type=member.resource_type,
            resource_id=member.resource_id,
            user_id=member.user_id,
            display_name=display_name,
            user_email=user_email,
            role=effective_role,
            status=member.status,
            entity_type=member.entity_type,
            entity_id=member.entity_id,
            entity_display_name=member.entity_display_name,
            source_type=source_type,
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
            db, resource_id, user_id, SchemaMemberRole.Maintainer
        )

        if owner_id != user_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to view pending requests"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        # We need to query both formats to handle legacy data
        resource_type_variants = self._resource_type_variants

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

        requests = []
        for m in pending_members:
            effective_role = m.get_effective_role()
            requests.append(
                PendingRequestResponse(
                    id=m.id,
                    user_id=m.user_id,
                    user_name=(
                        user_map.get(m.user_id).user_name
                        if user_map.get(m.user_id)
                        else None
                    ),
                    user_email=(
                        user_map.get(m.user_id).email
                        if user_map.get(m.user_id)
                        else None
                    ),
                    requested_role=effective_role,
                    requested_at=m.requested_at,
                )
            )

        return PendingRequestListResponse(requests=requests, total=len(requests))

    def review_request(
        self,
        db: Session,
        resource_id: int,
        request_id: int,
        reviewer_id: int,
        approved: bool,
        role: Optional[SchemaMemberRole] = None,
    ) -> ReviewRequestResponse:
        """Review (approve/reject) a pending request."""
        # Validate resource and ownership/manage permission
        resource = self._get_resource(db, resource_id, reviewer_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        owner_id = self._get_resource_owner_id(resource)
        has_manage = self.check_permission(
            db, resource_id, reviewer_id, SchemaMemberRole.Maintainer
        )

        if owner_id != reviewer_id and not has_manage:
            raise HTTPException(
                status_code=403, detail="No permission to review requests"
            )

        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

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
            if role:
                member.set_role(role.value)
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

        effective_role = member.get_effective_role()
        return ReviewRequestResponse(
            message="Request approved" if approved else "Request rejected",
            member_id=member.id,
            new_status=SchemaMemberStatus(member.status),
            role=effective_role if approved else None,
        )

    # =========================================================================
    # Permission Checking
    # =========================================================================

    def check_permission(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
        required_role: SchemaMemberRole,
    ) -> bool:
        """
        Check if user has required permission role.

        Checks both direct user-type permissions and entity-type memberships.
        Role hierarchy: Owner > Maintainer > Developer > Reporter > RestrictedAnalyst
        """
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

        # Note: Database may store status in different formats (e.g., "APPROVED" vs "approved")
        approved_status_variants = self._approved_status_variants

        from sqlalchemy import case

        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(approved_status_variants),
            )
            .order_by(
                # Prefer canonical resource_type, then most recent updated_at
                case(
                    (ResourceMember.resource_type == self.resource_type.value, 1),
                    else_=0,
                ).desc(),
                ResourceMember.updated_at.desc(),
            )
            .first()
        )

        if member:
            # Use effective role for permission check
            effective_role = member.get_effective_role()
            return has_permission(effective_role, required_role.value)

        # Fallback: check entity-type permissions (e.g., namespace)
        return self.check_entity_permission(db, resource_id, user_id, required_role)

    def get_user_role(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[str]:
        """Get user's role for a resource."""
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

        # Note: Database may store status in different formats (e.g., "APPROVED" vs "approved")
        approved_status_variants = self._approved_status_variants

        from sqlalchemy import case

        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(approved_status_variants),
            )
            .order_by(
                # Prefer canonical resource_type, then most recent updated_at
                case(
                    (ResourceMember.resource_type == self.resource_type.value, 1),
                    else_=0,
                ).desc(),
                ResourceMember.updated_at.desc(),
            )
            .first()
        )

        direct_role = member.get_effective_role() if member else None
        if direct_role == ResourceRole.Owner.value:
            return direct_role

        entity_role = self._get_highest_entity_role(db, resource_id, user_id)
        if direct_role and entity_role:
            return (
                direct_role if has_permission(direct_role, entity_role) else entity_role
            )
        return direct_role or entity_role

    def _get_highest_entity_role(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
    ) -> Optional[str]:
        """Get the highest role granted via entity-type memberships.

        Queries all entity bindings for the resource, resolves which entities
        match the user via registered resolvers, and returns the highest
        privilege role among matched bindings.
        """
        resource_type_variants = self._resource_type_variants
        approved_status_variants = self._approved_status_variants

        entity_rows = (
            db.query(
                ResourceMember.entity_type,
                ResourceMember.entity_id,
                ResourceMember.role,
            )
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type != "user",
                ResourceMember.entity_type != "",
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status.in_(approved_status_variants),
            )
            .all()
        )

        if not entity_rows:
            return None

        from collections import defaultdict

        entity_groups: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)
        for et, eid, role in entity_rows:
            if et and eid:
                entity_groups[et].append((eid, role))

        highest: Optional[str] = None
        for entity_type_str, entries in entity_groups.items():
            resolver = get_entity_resolver(entity_type_str)
            if not resolver:
                continue
            eids = [eid for eid, _ in entries]
            matched = resolver.match_entity_bindings(db, user_id, entity_type_str, eids)
            if not matched:
                continue
            role_by_eid = {eid: role for eid, role in entries}
            for eid in matched:
                role = role_by_eid.get(eid)
                if role and (highest is None or has_permission(role, highest)):
                    highest = role
        return highest

    def check_entity_permission(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
        required_role: SchemaMemberRole,
    ) -> bool:
        """
        Check if user has required permission via entity-type memberships.

        Base implementation only checks entity_type != 'user' ResourceMember records
        that match via external resolvers. Subclasses (e.g., KnowledgeShareService)
        should override this with resource-specific logic.

        Args:
            db: Database session
            resource_id: Resource ID
            user_id: User ID
            required_role: Required role level

        Returns:
            True if user has sufficient permission via entity membership
        """
        resource_type_variants = self._resource_type_variants

        approved_status_variants = self._approved_status_variants

        # Query entity bindings with their stored roles for precise checks
        entity_rows = (
            db.query(
                ResourceMember.entity_type,
                ResourceMember.entity_id,
                ResourceMember.role,
            )
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type != "user",
                ResourceMember.entity_type != "",
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status.in_(approved_status_variants),
            )
            .all()
        )

        if not entity_rows:
            return False

        from collections import defaultdict

        entity_groups: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)
        for et, eid, role in entity_rows:
            if et and eid:
                entity_groups[et].append((eid, role))

        for entity_type_str, entries in entity_groups.items():
            resolver = get_entity_resolver(entity_type_str)
            if not resolver:
                continue
            eids = [eid for eid, _ in entries]
            matched = resolver.match_entity_bindings(db, user_id, entity_type_str, eids)
            if not matched:
                continue
            # Build eid -> role lookup to avoid iterating all entries
            role_by_eid = {eid: role for eid, role in entries}
            for eid in matched:
                role = role_by_eid.get(eid)
                if role and has_permission(role, required_role):
                    return True

        return False

    def get_my_permission_sources(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
    ) -> MyPermissionSourcesResponse:
        """
        Get all permission sources for the current user on a resource.

        Base implementation returns direct ResourceMember permissions.
        Subclasses should override to include resource-specific sources
        (e.g., group membership, entity-type permissions).

        Args:
            db: Database session
            resource_id: Resource ID
            user_id: User ID

        Returns:
            MyPermissionSourcesResponse with all sources
        """
        resource_type_variants = self._resource_type_variants

        approved_status_variants = self._approved_status_variants

        # Get user-type direct permission
        user_member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(approved_status_variants),
            )
            .first()
        )

        sources: list[PermissionSourceInfo] = []
        roles: list[str] = []

        if user_member:
            effective_role = user_member.get_effective_role()
            source_type = self._resolve_source_type(user_member)
            user = db.query(User).filter(User.id == user_id).first()
            source_name = user.user_name if user else None
            sources.append(
                PermissionSourceInfo(
                    source_type=source_type,
                    display_name=source_name,
                    role=effective_role,
                    entity_type="user",
                    entity_id=str(user_id),
                )
            )
            roles.append(effective_role)

        effective_role = get_highest_role(roles) if roles else None

        return MyPermissionSourcesResponse(
            has_access=len(sources) > 0,
            effective_role=effective_role,
            is_creator=False,
            sources=sources,
        )
