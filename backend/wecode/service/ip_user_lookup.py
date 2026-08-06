# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve cloud-device and Kubernetes Pod IPs to Wegent users."""

import asyncio
import logging
from ipaddress import ip_address
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import DeviceType
from app.services.device.local_provider import local_device_provider
from wecode.service.nevis_client import nevis_client

logger = logging.getLogger(__name__)

CloudDeviceRow = Tuple[Kind, User]


def _same_ip(candidate: Any, expected: str) -> bool:
    """Compare IP addresses while tolerating alternate IPv6 spellings."""
    try:
        return ip_address(str(candidate)) == ip_address(expected)
    except ValueError:
        return False


class IpUserLookupService:
    """Combine IP ownership data from MySQL and executor_manager."""

    @staticmethod
    def _list_cloud_devices(db: Session) -> List[CloudDeviceRow]:
        rows = (
            db.query(Kind, User)
            .join(User, User.id == Kind.user_id)
            .filter(
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
                Kind.json["spec"]["deviceType"].as_string() == DeviceType.CLOUD.value,
            )
            .all()
        )
        return [
            row
            for row in rows
            if row[0].json.get("spec", {}).get("bindShell", "claudecode") != "openclaw"
        ]

    @staticmethod
    def _build_cloud_device_match(kind: Kind, user: User) -> Dict[str, Any]:
        return {
            "source": "cloud_device",
            "user_id": user.id,
            "user_name": user.user_name,
            "resource_name": kind.json.get("spec", {}).get("deviceId", kind.name),
            "resource_namespace": kind.namespace,
            "status": kind.json.get("status", {}).get("state"),
        }

    @staticmethod
    async def _find_nevis_matches(
        rows: List[CloudDeviceRow], ip_address: str
    ) -> Tuple[List[CloudDeviceRow], int]:
        semaphore = asyncio.Semaphore(10)

        async def matches(row: CloudDeviceRow) -> Tuple[CloudDeviceRow, bool, bool]:
            kind, _ = row
            cloud_config = kind.json.get("spec", {}).get("cloudConfig") or {}
            sandbox_id = cloud_config.get("sandboxId")
            if not sandbox_id:
                return row, False, False
            try:
                async with semaphore:
                    sandbox = await nevis_client.get_sandbox(sandbox_id)
            except Exception as exc:
                logger.debug("Failed to query Nevis sandbox %s: %s", sandbox_id, exc)
                return row, False, True
            nevis_ip = (sandbox.get("details") or {}).get("urls")
            return row, _same_ip(nevis_ip, ip_address), False

        results = await asyncio.gather(*(matches(row) for row in rows))
        return (
            [row for row, is_match, _ in results if is_match],
            sum(1 for _, _, failed in results if failed),
        )

    async def _find_cloud_device_matches(
        self, db: Session, ip_address: str
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        rows = self._list_cloud_devices(db)
        matched_rows = [
            row
            for row in rows
            if any(
                _same_ip(candidate, ip_address)
                for candidate in (
                    row[0].json.get("spec", {}).get("clientIp"),
                    row[0].json.get("spec", {}).get("runtimeTransferHost"),
                )
            )
        ]
        remaining = [row for row in rows if row not in matched_rows]

        redis_keys = [
            local_device_provider.generate_online_key(kind.user_id, kind.name)
            for kind, _ in remaining
        ]
        try:
            online_map = await cache_manager.mget(redis_keys) if redis_keys else {}
        except Exception as exc:
            logger.debug("Failed to query cloud device online IPs: %s", exc)
            online_map = {}

        unresolved = []
        for row, redis_key in zip(remaining, redis_keys):
            online_info = online_map.get(redis_key) or {}
            online_ips = (
                online_info.get("client_ip"),
                online_info.get("runtime_transfer_host"),
            )
            if any(_same_ip(candidate, ip_address) for candidate in online_ips):
                matched_rows.append(row)
            else:
                unresolved.append(row)

        nevis_rows, failed_count = await self._find_nevis_matches(
            unresolved, ip_address
        )
        matched_rows.extend(nevis_rows)
        error = None
        if failed_count:
            error = f"Failed to query {failed_count} cloud device IPs"
        return [self._build_cloud_device_match(*row) for row in matched_rows], error

    @staticmethod
    def _build_pod_matches(
        db: Session, pods: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        user_names = {pod.get("user_name") for pod in pods if pod.get("user_name")}
        users = (
            db.query(User).filter(User.user_name.in_(user_names)).all()
            if user_names
            else []
        )
        user_ids = {user.user_name: user.id for user in users}
        return [
            {
                "source": "k8s_pod",
                "user_id": user_ids.get(pod["user_name"]),
                "user_name": pod["user_name"],
                "resource_name": pod["pod_name"],
                "resource_namespace": pod.get("namespace"),
                "status": pod.get("phase"),
                "task_id": pod.get("task_id"),
            }
            for pod in pods
            if pod.get("user_name") and pod.get("pod_name")
        ]

    @staticmethod
    async def _find_pod_owners(
        ip_address: str,
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        url = (
            f"{settings.EXECUTOR_MANAGER_URL.rstrip('/')}"
            "/executor-manager/executor/pod-owners"
        )
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, params={"ip_address": ip_address})
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            return [], f"executor-manager Pod lookup failed: {exc}"

        if not isinstance(payload, dict):
            return [], "Invalid Pod IP lookup response"
        if payload.get("status") != "success":
            return [], payload.get("error_msg", "Pod IP lookup failed")
        pods = payload.get("pods")
        if not isinstance(pods, list):
            return [], "Invalid Pod IP lookup response"
        return pods, None

    async def lookup(self, db: Session, ip_address: str) -> Dict[str, Any]:
        """Return all known user associations for an IP address."""
        cloud_result, pod_result = await asyncio.gather(
            self._find_cloud_device_matches(db, ip_address),
            self._find_pod_owners(ip_address),
        )
        matches, cloud_error = cloud_result
        pods, pod_error = pod_result
        matches.extend(self._build_pod_matches(db, pods))
        lookup_errors = []
        if cloud_error:
            lookup_errors.append({"source": "cloud_device", "message": cloud_error})
        if pod_error:
            lookup_errors.append({"source": "k8s_pod", "message": pod_error})

        return {
            "ip": ip_address,
            "user_names": sorted({match["user_name"] for match in matches}),
            "matches": matches,
            "lookup_errors": lookup_errors,
        }


ip_user_lookup_service = IpUserLookupService()
