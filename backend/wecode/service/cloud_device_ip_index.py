# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Maintain the local Nevis IP index for cloud devices."""

import asyncio
import copy
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from ipaddress import ip_address
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.db.session import get_db_session
from app.models.kind import Kind
from app.schemas.device import DeviceType
from shared.telemetry.decorators import trace_async
from wecode.service.nevis_client import NEVIS_TIMEOUT, NevisClient, nevis_client

logger = logging.getLogger(__name__)

NEVIS_IP_FIELD = "nevisIp"
NEVIS_IP_OBSERVED_AT_FIELD = "nevisIpObservedAt"
NEVIS_IP_SYNC_CONCURRENCY = 10


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


class CloudDeviceIpIndexService:
    """Synchronize authoritative Nevis IPs into active Device CRDs."""

    def __init__(self, client: Optional[NevisClient] = None):
        self._client = client or nevis_client

    @staticmethod
    def _list_targets(db: Session) -> List[CloudDeviceIpTarget]:
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
            spec = device.json.get("spec", {})
            if spec.get("deviceType") != DeviceType.CLOUD.value:
                continue
            if spec.get("bindShell", "claudecode") == "openclaw":
                continue
            sandbox_id = (spec.get("cloudConfig") or {}).get("sandboxId")
            if sandbox_id:
                targets.append(
                    CloudDeviceIpTarget(
                        user_id=device.user_id,
                        device_name=device.name,
                        sandbox_id=sandbox_id,
                    )
                )
        return targets

    @staticmethod
    def _load_target(
        db: Session, user_id: int, device_name: str
    ) -> Optional[CloudDeviceIpTarget]:
        device = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.name == device_name,
                    Kind.is_active.is_(True),
                )
            )
            .first()
        )
        if not device:
            return None
        spec = device.json.get("spec", {})
        if spec.get("deviceType") != DeviceType.CLOUD.value:
            return None
        if spec.get("bindShell", "claudecode") == "openclaw":
            return None
        sandbox_id = (spec.get("cloudConfig") or {}).get("sandboxId")
        if not sandbox_id:
            return None
        return CloudDeviceIpTarget(user_id, device.name, sandbox_id)

    @staticmethod
    def persist_observation(
        db: Session,
        target: CloudDeviceIpTarget,
        nevis_ip: str,
        observed_at: Optional[str] = None,
    ) -> bool:
        """Persist one successful Nevis IP observation."""
        device = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == target.user_id,
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.name == target.device_name,
                    Kind.is_active.is_(True),
                )
            )
            .first()
        )
        if not device:
            return False
        device_json = copy.deepcopy(device.json)
        cloud_config = device_json.setdefault("spec", {}).setdefault("cloudConfig", {})
        if cloud_config.get("sandboxId") != target.sandbox_id:
            return False
        cloud_config[NEVIS_IP_FIELD] = nevis_ip
        cloud_config[NEVIS_IP_OBSERVED_AT_FIELD] = (
            observed_at or datetime.now(timezone.utc).isoformat()
        )
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
        span_name="wecode.cloud_device_ip_index.sync_all",
        tracer_name="backend.wecode",
    )
    async def sync_all(self, db: Session) -> CloudDeviceIpSyncSummary:
        """Synchronize all active cloud devices from Nevis."""
        if not self._client.is_configured():
            return CloudDeviceIpSyncSummary(0, 0, 0, 0, skipped=True)
        targets = self._list_targets(db)
        if not targets:
            return CloudDeviceIpSyncSummary(0, 0, 0, 0)

        ips, missing_ip, failed = await self._fetch_ips(targets)
        observed_at = datetime.now(timezone.utc).isoformat()
        persisted = sum(
            self.persist_observation(db, target, ips[target.sandbox_id], observed_at)
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

    @trace_async(
        span_name="wecode.cloud_device_ip_index.sync_device",
        tracer_name="backend.wecode",
    )
    async def sync_device(self, user_id: int, device_name: str) -> bool:
        """Synchronize one cloud device without reusing a request session."""
        if not self._client.is_configured():
            return False
        try:
            with get_db_session() as db:
                target = self._load_target(db, user_id, device_name)
            if target is None:
                return False

            ips, _, _ = await self._fetch_ips([target])
            nevis_ip = ips.get(target.sandbox_id)
            if nevis_ip is None:
                return False
            with get_db_session() as db:
                persisted = self.persist_observation(db, target, nevis_ip)
                if persisted:
                    db.commit()
                return persisted
        except Exception:
            logger.exception(
                "Failed to synchronize cloud-device Nevis IP: "
                "user_id=%s, device_name=%s",
                user_id,
                device_name,
            )
            return False


cloud_device_ip_index_service = CloudDeviceIpIndexService()
