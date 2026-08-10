# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Maintain the local Nevis IP index for cloud devices."""

import asyncio
import copy
import logging
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from ipaddress import ip_address
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional, Sequence

import httpx
from redis.asyncio import Redis
from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.db.session import get_db_session
from app.models.kind import Kind
from app.schemas.device import DeviceType
from shared.telemetry.decorators import trace_async
from wecode.service.nevis_client import NEVIS_TIMEOUT, NevisClient, nevis_client

logger = logging.getLogger(__name__)

NEVIS_IP_FIELD = "nevisIp"
NEVIS_IP_OBSERVED_AT_FIELD = "nevisIpObservedAt"
NEVIS_IP_SANDBOX_ID_FIELD = "nevisIpSandboxId"
NEVIS_IP_SYNC_CONCURRENCY = 10
NEVIS_IP_BACKFILL_LOCK_KEY = "cloud_device_ip_index:backfill:v1"
NEVIS_IP_DEVICE_LOCK_PREFIX = "cloud_device_ip_index:device"
NEVIS_IP_LOCK_TTL_SECONDS = 600
NEVIS_IP_LOCK_RENEW_INTERVAL_SECONDS = 60
NEVIS_IP_SYNC_RETRY_DELAYS_SECONDS = (0, 10, 30, 60)


@dataclass(frozen=True)
class CloudDeviceIpTarget:
    """One active cloud device that needs Nevis IP synchronization."""

    user_id: int
    device_name: str
    sandbox_id: str


@dataclass(frozen=True)
class CloudDeviceIpSyncSummary:
    """Aggregate result from one Nevis IP synchronization pass."""

    total: int
    persisted: int
    missing_ip: int
    failed: int
    skipped: bool = False
    skip_reason: Optional[str] = None


def normalize_nevis_ip(value: Any) -> Optional[str]:
    """Return a canonical IP from a Nevis sandbox response field."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        return str(ip_address(candidate))
    except ValueError:
        return None


def get_indexed_nevis_ip(cloud_config: Dict[str, Any]) -> Optional[str]:
    """Return a Nevis IP only when it belongs to the current sandbox."""
    sandbox_id = cloud_config.get("sandboxId")
    if not sandbox_id:
        return None
    if cloud_config.get(NEVIS_IP_SANDBOX_ID_FIELD) != sandbox_id:
        return None
    return normalize_nevis_ip(cloud_config.get(NEVIS_IP_FIELD))


async def _renew_redis_lock(lock: Any, lock_key: str) -> None:
    """Keep a redis-py owner-token lock alive while synchronization runs."""
    while True:
        await asyncio.sleep(NEVIS_IP_LOCK_RENEW_INTERVAL_SECONDS)
        try:
            renewed = await lock.extend(
                NEVIS_IP_LOCK_TTL_SECONDS,
                replace_ttl=True,
            )
        except Exception:
            logger.exception("Failed to renew Nevis IP lock: key=%s", lock_key)
            return
        if not renewed:
            logger.error("Lost Nevis IP lock ownership: key=%s", lock_key)
            return


@asynccontextmanager
async def acquire_nevis_ip_lock(
    redis_client: Redis,
    lock_key: str,
) -> AsyncGenerator[bool, None]:
    """Acquire a fail-closed distributed lock with safe owner-token release."""
    try:
        lock = redis_client.lock(
            lock_key,
            timeout=NEVIS_IP_LOCK_TTL_SECONDS,
            blocking_timeout=0,
        )
        acquired = bool(await lock.acquire(blocking=False))
    except Exception:
        logger.exception("Failed to acquire Nevis IP lock: key=%s", lock_key)
        yield False
        return
    if not acquired:
        yield False
        return

    renewal_task = asyncio.create_task(_renew_redis_lock(lock, lock_key))
    try:
        yield True
    finally:
        renewal_task.cancel()
        with suppress(asyncio.CancelledError):
            await renewal_task
        try:
            if await lock.owned():
                await lock.release()
        except Exception:
            logger.exception("Failed to release Nevis IP lock: key=%s", lock_key)


class CloudDeviceIpIndexService:
    """Synchronize authoritative Nevis IPs into active Device CRDs."""

    def __init__(
        self,
        client: Optional[NevisClient] = None,
        db_session_factory: Callable[[], Any] = get_db_session,
        retry_delays: Sequence[int] = NEVIS_IP_SYNC_RETRY_DELAYS_SECONDS,
    ):
        self._client = client or nevis_client
        self._db_session_factory = db_session_factory
        self._retry_delays = tuple(retry_delays)

    @staticmethod
    def _target_from_device(
        device: Kind,
        *,
        missing_only: bool,
    ) -> Optional[CloudDeviceIpTarget]:
        spec = device.json.get("spec", {})
        if spec.get("deviceType") != DeviceType.CLOUD.value:
            return None
        if spec.get("bindShell", "claudecode") == "openclaw":
            return None
        cloud_config = spec.get("cloudConfig") or {}
        sandbox_id = cloud_config.get("sandboxId")
        if not sandbox_id:
            return None
        if missing_only and get_indexed_nevis_ip(cloud_config) is not None:
            return None
        return CloudDeviceIpTarget(device.user_id, device.name, sandbox_id)

    @classmethod
    def _list_missing_targets(cls, db: Session) -> List[CloudDeviceIpTarget]:
        devices = (
            db.query(Kind)
            .filter(
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .all()
        )
        targets = []
        for device in devices:
            target = cls._target_from_device(device, missing_only=True)
            if target:
                targets.append(target)
        return targets

    @staticmethod
    def _load_device(
        db: Session,
        user_id: int,
        device_name: str,
        *,
        for_update: bool = False,
    ) -> Optional[Kind]:
        query = db.query(Kind).filter(
            and_(
                Kind.user_id == user_id,
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.name == device_name,
                Kind.is_active.is_(True),
            )
        )
        if for_update:
            query = query.populate_existing().with_for_update()
        return query.first()

    @classmethod
    def _load_missing_target(
        cls,
        db: Session,
        user_id: int,
        device_name: str,
    ) -> Optional[CloudDeviceIpTarget]:
        device = cls._load_device(db, user_id, device_name)
        if device is None:
            return None
        return cls._target_from_device(device, missing_only=True)

    @classmethod
    def persist_observation(
        cls,
        db: Session,
        target: CloudDeviceIpTarget,
        nevis_ip: str,
        observed_at: Optional[str] = None,
        *,
        only_if_missing: bool = False,
    ) -> bool:
        """Persist one observation after locking and reloading the Device row."""
        device = cls._load_device(
            db,
            target.user_id,
            target.device_name,
            for_update=True,
        )
        if not device:
            return False
        device_json = copy.deepcopy(device.json)
        cloud_config = device_json.setdefault("spec", {}).setdefault("cloudConfig", {})
        if cloud_config.get("sandboxId") != target.sandbox_id:
            return False
        if only_if_missing and get_indexed_nevis_ip(cloud_config) is not None:
            return False
        cloud_config[NEVIS_IP_FIELD] = nevis_ip
        cloud_config[NEVIS_IP_OBSERVED_AT_FIELD] = (
            observed_at or datetime.now(timezone.utc).isoformat()
        )
        cloud_config[NEVIS_IP_SANDBOX_ID_FIELD] = target.sandbox_id
        device.json = device_json
        flag_modified(device, "json")
        db.add(device)
        return True

    async def _fetch_ips(
        self, targets: List[CloudDeviceIpTarget]
    ) -> tuple[Dict[str, str], int, int]:
        sandbox_ids = list(dict.fromkeys(target.sandbox_id for target in targets))
        semaphore = asyncio.Semaphore(NEVIS_IP_SYNC_CONCURRENCY)
        ips: Dict[str, str] = {}
        missing_ip = 0
        failed = 0

        async with httpx.AsyncClient(timeout=NEVIS_TIMEOUT) as http_client:

            async def fetch(sandbox_id: str) -> None:
                nonlocal missing_ip, failed
                try:
                    async with semaphore:
                        sandbox = await self._client.get_sandbox(
                            sandbox_id, http_client=http_client
                        )
                except Exception as exc:
                    failed += 1
                    logger.warning(
                        "Failed to synchronize Nevis IP: sandbox_id=%s, error_type=%s",
                        sandbox_id,
                        type(exc).__name__,
                    )
                    return
                nevis_ip = normalize_nevis_ip(
                    (sandbox.get("details") or {}).get("urls")
                )
                if nevis_ip is None:
                    missing_ip += 1
                    return
                ips[sandbox_id] = nevis_ip

            await asyncio.gather(*(fetch(sandbox_id) for sandbox_id in sandbox_ids))
        return ips, missing_ip, failed

    @trace_async(
        span_name="wecode.cloud_device_ip_index.sync_missing",
        tracer_name="backend.wecode",
    )
    async def sync_missing(
        self,
        db: Session,
        redis_client: Redis,
    ) -> CloudDeviceIpSyncSummary:
        """Backfill only missing or sandbox-mismatched Nevis IP entries."""
        if not self._client.is_configured():
            return CloudDeviceIpSyncSummary(
                0,
                0,
                0,
                0,
                skipped=True,
                skip_reason="nevis_not_configured",
            )

        async with acquire_nevis_ip_lock(
            redis_client,
            NEVIS_IP_BACKFILL_LOCK_KEY,
        ) as acquired:
            if not acquired:
                return CloudDeviceIpSyncSummary(
                    0,
                    0,
                    0,
                    0,
                    skipped=True,
                    skip_reason="lock_not_acquired",
                )
            targets = self._list_missing_targets(db)
            if not targets:
                return CloudDeviceIpSyncSummary(0, 0, 0, 0)

            ips, missing_ip, failed = await self._fetch_ips(targets)
            observed_at = datetime.now(timezone.utc).isoformat()
            persisted = sum(
                self.persist_observation(
                    db,
                    target,
                    ips[target.sandbox_id],
                    observed_at,
                    only_if_missing=True,
                )
                for target in targets
                if target.sandbox_id in ips
            )
            if persisted:
                db.commit()
            return CloudDeviceIpSyncSummary(
                total=len(targets),
                persisted=persisted,
                missing_ip=missing_ip,
                failed=failed,
            )

    @staticmethod
    def _device_lock_key(target: CloudDeviceIpTarget) -> str:
        return (
            f"{NEVIS_IP_DEVICE_LOCK_PREFIX}:{target.user_id}:"
            f"{target.device_name}:{target.sandbox_id}"
        )

    @staticmethod
    def _create_redis_client() -> Redis:
        return Redis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_timeout=5,
            socket_connect_timeout=5,
        )

    async def _sync_device_with_lock(
        self,
        initial_target: CloudDeviceIpTarget,
        redis_client: Redis,
    ) -> bool:
        lock_key = self._device_lock_key(initial_target)
        async with acquire_nevis_ip_lock(redis_client, lock_key) as acquired:
            if not acquired:
                return False
            for delay in self._retry_delays:
                if delay:
                    await asyncio.sleep(delay)
                with self._db_session_factory() as db:
                    target = self._load_missing_target(
                        db,
                        initial_target.user_id,
                        initial_target.device_name,
                    )
                if target is None:
                    return True
                if target.sandbox_id != initial_target.sandbox_id:
                    return False

                ips, _, _ = await self._fetch_ips([target])
                nevis_ip = ips.get(target.sandbox_id)
                if nevis_ip is None:
                    continue
                with self._db_session_factory() as db:
                    persisted = self.persist_observation(
                        db,
                        target,
                        nevis_ip,
                        only_if_missing=True,
                    )
                    if persisted:
                        db.commit()
                        return True
                    if (
                        self._load_missing_target(
                            db,
                            target.user_id,
                            target.device_name,
                        )
                        is None
                    ):
                        return True
            return False

    @trace_async(
        span_name="wecode.cloud_device_ip_index.sync_device",
        tracer_name="backend.wecode",
    )
    async def sync_device(
        self,
        user_id: int,
        device_name: str,
        redis_client: Optional[Redis] = None,
    ) -> bool:
        """Synchronize one missing IP under a per-device distributed lock."""
        if not self._client.is_configured():
            return False
        owns_redis_client = False
        try:
            if redis_client is None:
                redis_client = self._create_redis_client()
                owns_redis_client = True
            with self._db_session_factory() as db:
                target = self._load_missing_target(db, user_id, device_name)
            if target is None:
                return False
            return await self._sync_device_with_lock(target, redis_client)
        except Exception:
            logger.exception(
                "Failed to synchronize cloud-device Nevis IP: "
                "user_id=%s, device_name=%s",
                user_id,
                device_name,
            )
            return False
        finally:
            if owns_redis_client and redis_client is not None:
                try:
                    await redis_client.aclose()
                except Exception:
                    logger.exception("Failed to close Nevis IP Redis client")


cloud_device_ip_index_service = CloudDeviceIpIndexService()
