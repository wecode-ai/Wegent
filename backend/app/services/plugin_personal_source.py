"""Validate the account ownership required to preserve an authored source."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin


def owns_personal_plugin(db: Session, installed: Kind, user_id: int) -> bool:
    """Resolve catalog ownership from the current installation and Plugin row."""
    spec = installed.json.get("spec", {})
    plugin_id = spec.get("pluginId") or (spec.get("source") or {}).get("catalogItemId")
    if isinstance(plugin_id, str) and plugin_id.isascii() and plugin_id.isdecimal():
        plugin_id = int(plugin_id)
    if isinstance(plugin_id, bool) or not isinstance(plugin_id, int) or plugin_id <= 0:
        return False
    return (
        db.query(Plugin.id)
        .filter(
            Plugin.id == plugin_id,
            Plugin.owner_user_id == user_id,
            Plugin.visibility == "personal",
        )
        .first()
        is not None
    )
