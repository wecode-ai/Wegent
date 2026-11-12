"""Transaction fences on the installation shared by its authentication rows."""

import json
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.plugin_sync_revision import remember_sync_write
from app.services.plugin_write_errors import PluginWriteError


@dataclass
class PluginWriteRevision:
    row_id: int
    user_id: int
    name: str
    revision: int
    # Only a successful write in this SQL transaction may satisfy its fence.
    advanced: bool = False


@dataclass
class PluginCreationRevision:
    state_id: int
    user_id: int
    name: str
    revision: int
    installed_kind_id: int = 0


def read_creation_revision(
    db: Session, user_id: int, name: str
) -> PluginCreationRevision:
    """Fence first insertion in existing sync metadata, before a parent exists."""
    from app.services.device.plugin_sync_protocol import lock_plugin_sync_state

    state = lock_plugin_sync_state(db, user_id, merge=True, plugin_key=name)
    if state.installed_kind_id:
        with db.no_autoflush:
            previous = (
                db.query(Kind.id)
                .filter_by(
                    id=state.installed_kind_id,
                    user_id=user_id,
                    kind="InstalledPlugin",
                    namespace="default",
                )
                .one_or_none()
            )
        if previous is not None:
            raise PluginWriteError("plugin_write_conflict")
    revisions = state.json.get("spec", {}).get("creationRevisions", {})
    if not isinstance(revisions, dict):
        raise PluginWriteError("plugin_write_conflict")
    revision = revisions.get(name, 0)
    if type(revision) is not int or not 0 <= revision < 2**63 - 1:
        raise PluginWriteError("plugin_write_conflict")
    return PluginCreationRevision(
        state.id, user_id, name, revision, state.installed_kind_id
    )


def advance_creation_revision(
    db: Session, expected: PluginCreationRevision, installed_kind_id: int
) -> None:
    """Compare only this plugin's slot; unrelated creations never conflict."""
    path = f"$.spec.creationRevisions.{json.dumps(expected.name)}"
    slots = func.coalesce(
        func.json_extract(PluginState.json, "$.spec.creationRevisions"),
        func.json_object(),
    )
    document = func.json_set(PluginState.json, "$.spec.creationRevisions", slots)
    revision = func.coalesce(PluginState.json["spec"]["revision"].as_integer(), 0)
    updated = (
        db.query(PluginState)
        .filter(
            PluginState.id == expected.state_id,
            PluginState.user_id == expected.user_id,
            PluginState.plugin_key == expected.name,
            PluginState.installed_kind_id.in_(
                {expected.installed_kind_id, installed_kind_id}
            ),
            func.coalesce(
                PluginState.json["spec"]["creationRevisions"][
                    expected.name
                ].as_integer(),
                0,
            )
            == expected.revision,
        )
        .update(
            {
                PluginState.installed_kind_id: installed_kind_id,
                PluginState.json: func.json_set(
                    document,
                    path,
                    expected.revision + 1,
                    "$.spec.revision",
                    revision + 1,
                ),
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise PluginWriteError("plugin_write_conflict")
    expected.revision += 1

    remember_sync_write(db, expected.user_id, expected.name)


def mark_plugin_desired_changed(
    db: Session, user_id: int, name: str, installed_id: int | None = None
) -> None:
    db.info.setdefault("plugin_desired_changed", set()).add(
        (user_id, name, installed_id)
    )


def write_revision(document: dict) -> int:
    if not isinstance(document, dict) or not isinstance(document.get("spec", {}), dict):
        raise PluginWriteError("plugin_write_conflict")
    value = document.get("spec", {}).get("writeRevision", 0)
    if type(value) is not int or not 0 <= value < 2**63 - 1:
        raise PluginWriteError("plugin_write_conflict")
    return value


def read_plugin_revisions(
    db: Session, user_id: int, name: str
) -> dict[int, PluginWriteRevision]:
    with db.no_autoflush:
        rows = db.execute(
            select(Kind.id, Kind.json).where(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.name == name,
            )
        ).all()
    return {
        row.id: PluginWriteRevision(row.id, user_id, name, write_revision(row.json))
        for row in rows
    }


def require_plugin_write_leases(db: Session, user_id: int) -> None:
    """Nested authentication helpers must inherit their caller's target scope."""
    leases = [
        lease
        for (owner, _), lease in db.info.get("plugin_write_leases", {}).items()
        if owner == user_id
    ]
    parents = db.info.get("plugin_installation_write_revisions", {}).values()
    if not leases or not any(parent.user_id == user_id for parent in parents):
        raise PluginWriteError("plugin_write_conflict")
    for lease in leases:
        lease.check()


def advance_plugin_revision(db: Session, expected: PluginWriteRevision) -> None:
    """Fence dependent writes without changing the installation's intent revision."""
    updated = (
        db.query(Kind)
        .filter(
            Kind.id == expected.row_id,
            Kind.user_id == expected.user_id,
            Kind.kind == "InstalledPlugin",
            Kind.namespace == "default",
            Kind.name == expected.name,
            func.coalesce(Kind.json["spec"]["writeRevision"].as_integer(), 0)
            == expected.revision,
        )
        .update(
            {
                Kind.json: func.json_set(
                    Kind.json, "$.spec.writeRevision", expected.revision + 1
                )
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise PluginWriteError("plugin_write_conflict")
    expected.revision += 1
    expected.advanced = True
