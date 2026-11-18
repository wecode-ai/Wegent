"""Request-local owned-device identities for plugin response projection."""

from collections.abc import Iterable

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.device.identity import record_id_from_route, resolve_device_alias
from app.services.plugin_device_identity import canonical_plugin_device_id


class PluginDeviceSnapshot:
    """Resolve aliases once without retaining state across writes or requests."""

    def __init__(self, devices: list[Kind]):
        self._devices: dict[int, list[Kind]] = {}
        self._identities: dict[tuple[int, str], str] = {}
        for device in devices:
            self._devices.setdefault(device.user_id, []).append(device)

    @classmethod
    def load(
        cls, db: Session, identities: Iterable[tuple[int, str]]
    ) -> "PluginDeviceSnapshot":
        scopes: dict[int, set[int] | None] = {}
        for user_id, submitted in identities:
            submitted = submitted.strip()
            if not submitted:
                continue
            ids = scopes.setdefault(user_id, set())
            if ids is not None:
                record_id = record_id_from_route(submitted)
                if record_id is None:
                    scopes[user_id] = None
                else:
                    ids.add(record_id)
        if not scopes:
            return cls([])
        owners = [
            (
                Kind.user_id == user_id
                if ids is None
                else and_(Kind.user_id == user_id, Kind.id.in_(sorted(ids)))
            )
            for user_id, ids in sorted(scopes.items())
        ]
        devices = (
            db.query(Kind)
            .filter(
                or_(*owners),
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .all()
        )
        return cls(devices)

    def resolve(self, user_id: int, submitted: str) -> str:
        key = (user_id, submitted)
        if key not in self._identities:
            device = resolve_device_alias(self._devices.get(user_id, []), submitted)
            self._identities[key] = canonical_plugin_device_id(device, submitted)
        return self._identities[key]
