"""Optimistic updates for existing installed-plugin Kind records."""

from copy import deepcopy
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.plugin_write_errors import PluginWriteError


def kind_revision(row: Kind) -> int:
    """Treat records written before revision tracking as version zero."""
    payload = row.json if isinstance(row.json, dict) else {}
    spec = payload.get("spec") if isinstance(payload.get("spec"), dict) else {}
    revision = spec.get("revision", 0)
    if type(revision) is not int or not 0 <= revision < 2**63 - 1:
        raise PluginWriteError("plugin_write_conflict")
    return revision


def replace_installed_kind(
    db: Session,
    row: Kind,
    payload: dict[str, Any],
    *,
    is_active: bool | None = None,
    name: str | None = None,
) -> None:
    """Replace one install only if its observed business revision still matches."""
    revision = kind_revision(row)
    replacement = deepcopy(payload)
    replacement.setdefault("spec", {})["revision"] = revision + 1
    values: dict[Any, Any] = {Kind.json: replacement}
    if is_active is not None:
        values[Kind.is_active] = is_active
    if name is not None:
        values[Kind.name] = name
    with db.no_autoflush:
        updated = (
            db.query(Kind)
            .filter(
                Kind.id == row.id,
                Kind.user_id == row.user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == row.namespace,
                Kind.name == row.name,
                func.coalesce(Kind.json["spec"]["revision"].as_integer(), 0)
                == revision,
            )
            .update(values, synchronize_session=False)
        )
        if updated != 1:
            raise PluginWriteError("plugin_write_conflict")
        db.refresh(row)
