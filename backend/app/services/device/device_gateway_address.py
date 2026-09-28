# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared address resolution for a device's Executor session gateway."""

from ipaddress import ip_address
from typing import Optional

from app.core.constants import EXECUTOR_SESSION_GATEWAY_DEFAULT_PORT


def _is_unusable_address(address: object) -> bool:
    """Reject addresses no other machine can reach."""
    return (
        address.is_loopback
        or address.is_unspecified
        or address.is_multicast
        or address.is_link_local
    )


def usable_device_ip(value: object) -> Optional[str]:
    """Return a canonical IP that another machine can address directly."""
    if not isinstance(value, str):
        return None
    try:
        address = ip_address(value.strip())
    except ValueError:
        return None
    if _is_unusable_address(address):
        return None
    return str(address)


def usable_device_host(value: object) -> str:
    """Return a reachable address or hostname, or ``""``.

    Unlike :func:`usable_device_ip` this also accepts a hostname, because an
    operator can point a device at a name the backend cannot observe. Literal
    addresses still have to be reachable, so ``localhost`` is rejected either
    way.
    """
    if not isinstance(value, str):
        return ""
    host = value.strip().strip("[]")
    if not host or host.lower() == "localhost":
        return ""
    try:
        address = ip_address(host)
    except ValueError:
        return host
    if _is_unusable_address(address):
        return ""
    return str(address)


def reported_gateway_port(spec: dict) -> Optional[int]:
    """Return the port the Executor reported as bound, if it is plausible."""
    value = spec.get("runtimeTransferPort")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 1 <= value <= 65535 else None


def gateway_port(spec: dict, resolved_host: Optional[str]) -> Optional[int]:
    """Return the reported gateway port, or the legacy Executor default.

    Returns ``None`` when no host was resolved, because a port without a
    reachable host is not an address, and when the reported value is not a
    plausible port.
    """
    if resolved_host is None:
        return None
    if "runtimeTransferPort" not in spec:
        return EXECUTOR_SESSION_GATEWAY_DEFAULT_PORT
    return reported_gateway_port(spec)


def reported_device_address(spec: dict) -> tuple[Optional[str], Optional[int]]:
    """Resolve the address a device reported for itself and its gateway port.

    Prefers the host the Executor advertises for direct transfers, falling back
    to the address the backend observed when it connected.
    """
    host = usable_device_ip(spec.get("runtimeTransferHost")) or usable_device_ip(
        spec.get("clientIp")
    )
    return host, gateway_port(spec, host)
