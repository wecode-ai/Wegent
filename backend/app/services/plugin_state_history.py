"""Read frozen legacy baselines without creating or changing account state."""

from copy import deepcopy

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.plugin_state_documents import validate_document
from app.services.plugin_write_errors import PluginWriteError

LEGACY_SYNC_KEY = "@legacy-v2"


def legacy_document(db: Session, user_id: int) -> dict:
    """A materialized legacy stream takes precedence over the frozen Kind."""
    with db.no_autoflush:
        state = (
            db.query(PluginState)
            .filter_by(user_id=user_id, plugin_key=LEGACY_SYNC_KEY)
            .one_or_none()
        )
        if state is not None:
            document = state.json
        else:
            rows = (
                db.query(Kind)
                .filter_by(
                    user_id=user_id,
                    kind="PluginSyncState",
                    namespace="plugin-sync",
                    name="account",
                    is_active=True,
                )
                .limit(2)
                .all()
            )
            if len(rows) > 1:
                raise PluginWriteError("plugin_write_conflict")
            document = rows[0].json if rows else {}
    try:
        validate_document(document)
    except RuntimeError:
        raise PluginWriteError("plugin_write_conflict") from None
    return deepcopy(document)


def historical_slots(
    db: Session,
    user_id: int,
    instance_id: str,
    field: str,
    states: list[PluginState],
) -> dict:
    """Never resurrect a frozen receipt superseded by a new plugin document."""
    initialized = {
        str(row.installed_kind_id) for row in states if row.installed_kind_id
    }
    slots = (
        legacy_document(db, user_id).get("spec", {}).get(field, {}).get(instance_id, {})
    )
    return {key: value for key, value in slots.items() if key not in initialized}
