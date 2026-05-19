# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
ERP entity resolver implementation.

Concrete implementation of IExternalEntityResolver that handles
org_department entity type by checking ERP department membership.
"""

import logging
import time
from typing import Optional

import orjson
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.distributed_lock import distributed_lock
from app.models.user import User
from app.services.share.external_entity_resolver import IExternalEntityResolver
from wecode.cache.base import get_redis_client
from wecode.models.erp_user import WecodeErpUser
from wecode.service.erp_client import erp_client
from wecode.service.erp_user_service import ErpUserService

logger = logging.getLogger(__name__)


class ErpEntityResolver(IExternalEntityResolver):
    """Resolves org_department entity bindings using ERP OpenSearch API v2.

    For a given user, this resolver:
    1. Looks up the user's employee_id (SSN) from wecode_erp_user
    2. Calls ERP batch_check_membership to verify department membership
    """

    _CACHE_TTL = 900  # 15 minutes; user-department relationships change infrequently

    def __init__(self):
        # Defer redis client acquisition so a transient startup outage
        # does not permanently disable caching.
        self._redis = None

    @property
    def _redis_client(self):
        if self._redis is None:
            self._redis = get_redis_client()
        return self._redis

    @staticmethod
    def _mask_ssn(ssn: str) -> str:
        """Return a redacted SSN for logging (first 2 + **** + last 2)."""
        if not ssn or len(ssn) <= 4:
            return "****"
        return ssn[:2] + "****" + ssn[-2:]

    def _cache_get(self, key: str):
        client = self._redis_client
        if client is None:
            return None
        try:
            data = client.get(key)
            return orjson.loads(data) if data else None
        except Exception as e:
            logger.warning(f"erp cache get {key} failed: {e}")
            return None

    def _cache_set(self, key: str, value) -> None:
        client = self._redis_client
        if client is None:
            return
        try:
            client.set(key, orjson.dumps(value), ex=self._CACHE_TTL)
        except Exception as e:
            logger.warning(f"erp cache set {key} failed: {e}")

    def _get_membership_with_cache(
        self, user_id: int, ssn: str, dept_ids: list[str]
    ) -> dict[str, bool]:
        """Get membership results with Redis cache.

        Cache key: erp:membership:{user_id}:{ssn}
        Cache value: {dept_id: bool} mapping for the most recently
        requested departments only. Old departments not in the current
        request are dropped to avoid unbounded growth and to prevent
        stale entries from being kept alive forever via TTL refresh.
        """
        if not dept_ids:
            return {}

        cache_key = f"erp:membership:{user_id}:{ssn}"
        cached = self._cache_get(cache_key)

        if cached and isinstance(cached, dict):
            missing = [d for d in dept_ids if d not in cached]
            if not missing:
                return {d: cached[d] for d in dept_ids}

            # Partial hit: query only missing departments and rebuild a fresh
            # cache scoped to the current request, so stale entries from
            # previous requests do not survive indefinitely.
            result = erp_client.batch_check_membership(ssn, missing)
            fresh: dict[str, bool] = {}
            for d in dept_ids:
                if d in result:
                    fresh[d] = result[d]
                else:
                    fresh[d] = cached.get(d, False)
            self._cache_set(cache_key, fresh)
            return fresh

        # Cache miss: query all and store
        result = erp_client.batch_check_membership(ssn, dept_ids)
        self._cache_set(cache_key, result)
        return result

    @property
    def requires_display_name_snapshot(self) -> bool:
        """ERP department names come from an external API that may be unavailable."""
        return True

    def _resolve_matched_departments(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        dept_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> list[str]:
        """Shared logic: filter dept_ids down to those the user is a member of."""
        if entity_type != "org_department":
            return []
        if not dept_ids:
            return []
        ssn = self._get_user_ssn(db, user_id, user_context)
        if not ssn:
            return []
        membership = self._get_membership_with_cache(user_id, ssn, dept_ids)
        matched = [d for d in dept_ids if membership.get(d, False)]
        if matched:
            logger.info(
                f"User user_id={user_id} (ssn={self._mask_ssn(ssn)}) "
                f"matched departments {matched} via ERP API"
            )
        return matched

    def match_entity_bindings(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        entity_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> list[str]:
        return self._resolve_matched_departments(
            db, user_id, entity_type, entity_ids, user_context
        )

    def get_display_name(self, db: Session, entity_id: str) -> Optional[str]:
        """Resolve department name for org_department entity IDs.

        Currently returns None because the ERP API does not support
        resolving department names by department ID.
        """
        return None

    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        if entity_type != "org_department":
            return []

        # Find all KBs with org_department bindings
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        all_dept_bindings = (
            db.query(ResourceMember.entity_id)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.entity_type == "org_department",
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .distinct()
            .all()
        )

        dept_ids = [b.entity_id for b in all_dept_bindings if b.entity_id]
        logger.info(
            f"get_resource_ids_by_entity: user_id={user_id} "
            f"total_org_department_bindings={len(dept_ids)}"
        )
        if not dept_ids:
            return []

        matched_depts = self._resolve_matched_departments(
            db, user_id, entity_type, dept_ids, user_context
        )
        logger.info(
            f"get_resource_ids_by_entity: membership_check "
            f"matched={len(matched_depts)}/{len(dept_ids)} "
            f"matched_ids={matched_depts}"
        )
        if not matched_depts:
            return []

        results = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.entity_type == "org_department",
                ResourceMember.entity_id.in_(matched_depts),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        kb_ids = list(set(r.resource_id for r in results))
        logger.info(
            f"get_resource_ids_by_entity: resolved_kb_ids={kb_ids} "
            f"for user_id={user_id}"
        )
        return kb_ids

    def _read_profile_employee_id(self, db: Session, user_id: int) -> Optional[str]:
        profile = (
            db.query(WecodeErpUser).filter(WecodeErpUser.user_id == user_id).first()
        )
        if profile and profile.employee_id:
            return profile.employee_id
        return None

    def _get_user_ssn(
        self, db: Session, user_id: int, user_context: Optional[dict] = None
    ) -> Optional[str]:
        """Get user SSN (employee_id) from context or database.

        If no profile exists, attempt lazy-sync from ERP OpenSearch API.
        Uses distributed locking to prevent concurrent ERP API storms.
        """
        if user_context and "employee_id" in user_context:
            return user_context["employee_id"]

        existing = self._read_profile_employee_id(db, user_id)
        if existing:
            return existing

        # Resolve user_name BEFORE acquiring the lock so we don't hold the
        # caller's db connection across network I/O / sleeps.
        user = db.query(User).filter(User.id == user_id).first()
        user_name = user.user_name if user else None
        if not user_name:
            logger.info(
                f"No user_name found for user_id={user_id}, cannot sync ERP profile"
            )
            return None

        lock_name = f"erp_profile_sync:{user_id}"
        with distributed_lock.acquire_context(lock_name, expire_seconds=30) as acquired:
            if not acquired:
                # Another worker is syncing; back off and retry the read a
                # few times before giving up.
                for delay in (0.5, 1.0, 2.0):
                    time.sleep(delay)
                    existing = self._read_profile_employee_id(db, user_id)
                    if existing:
                        return existing
                return None

            # Double-check after acquiring the lock in case another worker
            # finished syncing between our first read and lock acquisition.
            existing = self._read_profile_employee_id(db, user_id)
            if existing:
                return existing

            try:
                erp_employee = erp_client.search_employee(user_name)
            except Exception as e:
                logger.warning(
                    f"Failed to lazy-sync ERP profile for user_id={user_id}: {e}"
                )
                return None

            if not (erp_employee and erp_employee.ssn):
                logger.info(
                    f"No ERP employee found for user_id={user_id} "
                    f"with username={user_name}"
                )
                return None

            # Use an independent session so commits do not affect the
            # caller's transaction.
            from app.db.session import SessionLocal

            indb = SessionLocal()
            try:
                ErpUserService.upsert_profile(
                    db=indb,
                    user_id=user_id,
                    employee_id=erp_employee.ssn,
                    department_name=erp_employee.department,
                    erp_name=erp_employee.name,
                    email=erp_employee.email,
                )
                logger.info(
                    f"Lazy-synced ERP profile for user_id={user_id}: "
                    f"emp={self._mask_ssn(erp_employee.ssn)}"
                )
                return erp_employee.ssn
            except IntegrityError:
                indb.rollback()
                # Another request may have created the profile concurrently
                concurrent = (
                    indb.query(WecodeErpUser)
                    .filter(WecodeErpUser.user_id == user_id)
                    .first()
                )
                if concurrent and concurrent.employee_id:
                    return concurrent.employee_id
                return None
            except Exception as e:
                indb.rollback()
                logger.warning(
                    f"Failed to lazy-sync ERP profile for user_id={user_id}: {e}"
                )
                return None
            finally:
                indb.close()
