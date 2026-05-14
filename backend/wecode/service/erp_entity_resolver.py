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
from datetime import datetime
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

logger = logging.getLogger(__name__)


class ErpEntityResolver(IExternalEntityResolver):
    """Resolves org_department entity bindings using ERP OpenSearch API v2.

    For a given user, this resolver:
    1. Looks up the user's employee_id (SSN) from wecode_erp_user
    2. Calls ERP batch_check_membership to verify department membership
    """

    _CACHE_TTL = 900  # 15 minutes; user-department relationships change infrequently

    def __init__(self):
        # Sync Redis client shared with other wecode/cache/* modules.
        # None when redis is unavailable; callers degrade gracefully.
        self._redis = get_redis_client()

    def _cache_get(self, key: str):
        if self._redis is None:
            return None
        try:
            data = self._redis.get(key)
            return orjson.loads(data) if data else None
        except Exception as e:
            logger.warning(f"erp cache get {key} failed: {e}")
            return None

    def _cache_set(self, key: str, value) -> None:
        if self._redis is None:
            return
        try:
            self._redis.set(key, orjson.dumps(value), ex=self._CACHE_TTL)
        except Exception as e:
            logger.warning(f"erp cache set {key} failed: {e}")

    def _get_membership_with_cache(
        self, user_id: int, ssn: str, dept_ids: list[str]
    ) -> dict[str, bool]:
        """Get membership results with Redis cache.

        Cache key: erp:membership:{user_id}:{ssn}
        Cache value: {dept_id: bool} mapping of already-queried departments.
        Uses partial-hit + missing-requery pattern to minimize API calls.
        """
        if not dept_ids:
            return {}

        cache_key = f"erp:membership:{user_id}:{ssn}"
        cached = self._cache_get(cache_key)

        if cached and isinstance(cached, dict):
            missing = [d for d in dept_ids if d not in cached]
            if not missing:
                return {d: cached[d] for d in dept_ids}

            # Partial hit: query only missing departments
            result = erp_client.batch_check_membership(ssn, missing)
            cached.update(result)
            self._cache_set(cache_key, cached)
            return {d: cached.get(d, False) for d in dept_ids}

        # Cache miss: query all and store
        result = erp_client.batch_check_membership(ssn, dept_ids)
        self._cache_set(cache_key, result)
        return result

    @property
    def requires_display_name_snapshot(self) -> bool:
        """ERP department names come from an external API that may be unavailable."""
        return True

    def match_entity_bindings(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        entity_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> list[str]:
        if entity_type != "org_department":
            return []

        ssn = self._get_user_ssn(db, user_id, user_context)
        if not ssn:
            return []

        membership = self._get_membership_with_cache(user_id, ssn, entity_ids)
        matched = [dept_id for dept_id in entity_ids if membership.get(dept_id, False)]
        if matched:
            logger.info(
                f"User user_id={user_id} (ssn={ssn}) "
                f"matched departments {matched} via ERP API"
            )
        return matched

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

        ssn = self._get_user_ssn(db, user_id, user_context)
        if not ssn:
            logger.info(
                f"get_resource_ids_by_entity: no SSN for user_id={user_id}, "
                f"cannot resolve org_department KBs"
            )
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
            f"get_resource_ids_by_entity: user_id={user_id} ssn={ssn} "
            f"total_org_department_bindings={len(dept_ids)}"
        )
        if not dept_ids:
            return []

        membership = self._get_membership_with_cache(user_id, ssn, dept_ids)
        matched_depts = [d for d, is_member in membership.items() if is_member]
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

    def _get_user_ssn(
        self, db: Session, user_id: int, user_context: Optional[dict] = None
    ) -> Optional[str]:
        """Get user SSN (employee_id) from context or database.

        If no profile exists, attempt lazy-sync from ERP OpenSearch API.
        Uses distributed locking to prevent concurrent ERP API storms.
        """
        if user_context and "employee_id" in user_context:
            return user_context["employee_id"]

        profile = (
            db.query(WecodeErpUser).filter(WecodeErpUser.user_id == user_id).first()
        )
        if profile and profile.employee_id:
            return profile.employee_id

        # Lazy-sync with distributed lock to prevent concurrent ERP API calls
        lock_name = f"erp_profile_sync:{user_id}"
        with distributed_lock.acquire_context(lock_name, expire_seconds=30) as acquired:
            if not acquired:
                # Another worker is syncing; wait briefly and retry read
                time.sleep(0.5)
                profile = (
                    db.query(WecodeErpUser)
                    .filter(WecodeErpUser.user_id == user_id)
                    .first()
                )
                return profile.employee_id if profile and profile.employee_id else None

            # Double-check after acquiring lock
            profile = (
                db.query(WecodeErpUser).filter(WecodeErpUser.user_id == user_id).first()
            )
            if profile and profile.employee_id:
                return profile.employee_id

            # Perform lazy-sync using an independent session to avoid
            # polluting the caller's transaction with db.commit().
            try:
                user = db.query(User).filter(User.id == user_id).first()
                if not user or not user.user_name:
                    logger.info(
                        f"No user_name found for user_id={user_id}, "
                        f"cannot sync ERP profile"
                    )
                    return None

                erp_employee = erp_client.search_employee(user.user_name)
                if erp_employee and erp_employee.ssn:
                    from app.db.session import SessionLocal

                    indb = SessionLocal()
                    try:
                        new_profile = WecodeErpUser(
                            user_id=user_id,
                            employee_id=erp_employee.ssn,
                            department_name=erp_employee.department,
                            erp_name=erp_employee.name,
                            email=erp_employee.email,
                            last_synced_at=datetime.utcnow(),
                        )
                        indb.add(new_profile)
                        indb.commit()
                        logger.info(
                            f"Lazy-synced ERP profile for user_id={user_id}: "
                            f"emp={erp_employee.ssn}"
                        )
                        return erp_employee.ssn
                    except IntegrityError:
                        indb.rollback()
                        # Another request may have created the profile concurrently
                        existing = (
                            indb.query(WecodeErpUser)
                            .filter(WecodeErpUser.user_id == user_id)
                            .first()
                        )
                        if existing and existing.employee_id:
                            return existing.employee_id
                    except Exception as e:
                        indb.rollback()
                        logger.warning(
                            f"Failed to lazy-sync ERP profile for user_id={user_id}: {e}"
                        )
                    finally:
                        indb.close()
                else:
                    logger.info(
                        f"No ERP employee found for user_id={user_id} "
                        f"with username={user.user_name}"
                    )
            except Exception as e:
                logger.warning(
                    f"Failed to lazy-sync ERP profile for user_id={user_id}: {e}"
                )

        return None


erp_entity_resolver = ErpEntityResolver()
