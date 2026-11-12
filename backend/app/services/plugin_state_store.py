"""Create durable plugin identities using their database uniqueness constraint."""

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from app.models.plugin_state import PluginState
from app.services.plugin_write_errors import PluginWriteError

LEGACY_SYNC_KEY = "@legacy-v2"


def initial_document(plugin_key: str) -> dict:
    document = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "PluginState",
        "metadata": {"name": plugin_key, "namespace": "plugin-sync"},
        "spec": {"revision": 0, "generation": 0},
    }
    return document


def find_plugin_state(db: Session, user_id: int, plugin_key: str) -> PluginState | None:
    """Retain pending changes when a transaction re-enters the same identity."""
    for row in set(db.new) | set(db.dirty):
        if (
            isinstance(row, PluginState)
            and row.user_id == user_id
            and row.plugin_key == plugin_key
        ):
            return row
    with db.no_autoflush:
        return (
            db.query(PluginState)
            .filter_by(user_id=user_id, plugin_key=plugin_key)
            .populate_existing()
            .one_or_none()
        )


def ensure_plugin_state(
    db: Session,
    user_id: int,
    plugin_key: str,
    *,
    installed_kind_id: int = 0,
    previous_installed_id: int | None = None,
) -> PluginState:
    """Bootstrap once; even an uncertain COMMIT cannot create a second identity."""
    with db.no_autoflush:
        state = (
            db.query(PluginState)
            .filter_by(user_id=user_id, installed_kind_id=installed_kind_id)
            .one_or_none()
            if installed_kind_id
            else None
        )
    if state is None:
        state = find_plugin_state(db, user_id, plugin_key)
    elif state not in db.dirty:
        state = find_plugin_state(db, user_id, state.plugin_key)
    if state is None:
        _materialize(db, user_id, plugin_key, installed_kind_id)
        state = find_plugin_state(db, user_id, plugin_key)
    if state is None or (
        installed_kind_id
        and state.installed_kind_id not in {0, installed_kind_id, previous_installed_id}
    ):
        raise PluginWriteError("plugin_write_conflict")
    if installed_kind_id and state.installed_kind_id != installed_kind_id:
        db.info.setdefault("plugin_state_rebindings", {})[
            state.id
        ] = state.installed_kind_id
        state.installed_kind_id = installed_kind_id
    return state


def _materialize(
    db: Session, user_id: int, plugin_key: str, installed_kind_id: int
) -> None:
    bind = db.get_bind()
    if bind.dialect.name != "mysql":
        claim_plugin_identity(db, user_id, plugin_key, installed_kind_id)
        return
    from app.services.plugin_write_resources import policy_engine

    engine = bind.engine if isinstance(bind, Connection) else bind
    with Session(policy_engine(engine)) as initial, initial.begin():
        claim_plugin_identity(initial, user_id, plugin_key, installed_kind_id)


def claim_plugin_identity(
    db: Session, user_id: int, plugin_key: str, installed_kind_id: int = 0
) -> None:
    """Serialize one first insertion through the unique key until SQL COMMIT."""
    document = initial_document(plugin_key)
    if plugin_key != LEGACY_SYNC_KEY:
        legacy = find_plugin_state(db, user_id, LEGACY_SYNC_KEY)
        if legacy is not None:
            floor = legacy.json.get("spec", {}).get("generation", 0)
            if type(floor) is not int or not 0 <= floor < 2**63 - 1:
                raise PluginWriteError("plugin_write_conflict")
            document["spec"]["generation"] = floor
    values = dict(
        user_id=user_id,
        plugin_key=plugin_key,
        installed_kind_id=installed_kind_id,
        json=document,
    )
    if db.get_bind().dialect.name != "mysql":
        statement = sqlite_insert(PluginState).values(**values)
        statement = statement.on_conflict_do_nothing(
            index_elements=["user_id", "plugin_key"]
        )
        with db.no_autoflush:
            db.execute(statement)
        return

    statement = mysql_insert(PluginState).values(**values)
    with db.no_autoflush:
        db.execute(statement.on_duplicate_key_update(plugin_key=PluginState.plugin_key))
