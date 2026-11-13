"""Emit scalar event snapshots after their owning transaction commits."""

from collections.abc import Iterable
from typing import Any, TypeAlias

from shared.event_reporting.catalogs.knowledge import observe

FactSnapshot: TypeAlias = tuple[str, dict[str, Any]]


def emit_fact_snapshots(snapshots: Iterable[FactSnapshot]) -> None:
    """Best-effort emission for facts explicitly confirmed by a caller commit."""
    for event_type, fields in snapshots:
        try:
            observe(event_type, lambda fields=fields: fields)
        except Exception:
            continue
