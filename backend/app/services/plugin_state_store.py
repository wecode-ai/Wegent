"""Create durable plugin identities using their database uniqueness constraint."""

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.plugin_state_documents import initial_document, plugin_document
from app.services.plugin_state_history import LEGACY_SYNC_KEY, legacy_document
from app.services.plugin_write_errors import PluginWriteError


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
    with (
        Session(
            policy_engine(engine).execution_options(isolation_level="READ COMMITTED")
        ) as initial,
        initial.begin(),
    ):
        claim_plugin_identity(initial, user_id, plugin_key, installed_kind_id)


def claim_plugin_identity(
    db: Session, user_id: int, plugin_key: str, installed_kind_id: int = 0
) -> None:
    """Serialize one first insertion through the unique key until SQL COMMIT."""
    # Existing rows are authoritative, including zero-bound creation fences.
    if find_plugin_state(db, user_id, plugin_key) is not None:
        return
    values = prepare_plugin_identity(db, user_id, plugin_key, installed_kind_id)
    installed_kind_id = values["installed_kind_id"]
    if db.get_bind().dialect.name != "mysql":
        statement = sqlite_insert(PluginState).values(**values)
        statement = statement.on_conflict_do_nothing(
            index_elements=["user_id", "plugin_key"]
        )
        with db.no_autoflush:
            db.execute(statement)
        _validate_binding(db, user_id, plugin_key, installed_kind_id)
        return

    statement = mysql_insert(PluginState).values(**values)
    with db.no_autoflush:
        db.execute(statement.on_duplicate_key_update(plugin_key=PluginState.plugin_key))
    _validate_binding(db, user_id, plugin_key, installed_kind_id)


def _validate_binding(db: Session, user_id: int, key: str, installed_id: int) -> None:
    """A rename that won the insert race must not leave a second old alias."""
    if not installed_id:
        return
    with db.no_autoflush:
        parent = (
            db.query(Kind.id)
            .filter_by(
                id=installed_id,
                user_id=user_id,
                kind="InstalledPlugin",
                namespace="default",
                name=key,
            )
            .one_or_none()
        )
        bindings = (
            db.query(PluginState.id)
            .filter_by(
                user_id=user_id,
                installed_kind_id=installed_id,
            )
            .limit(2)
            .all()
        )
    if parent is None or len(bindings) != 1:
        raise PluginWriteError("plugin_write_conflict")


def prepare_plugin_identity(
    db: Session, user_id: int, plugin_key: str, installed_kind_id: int = 0
) -> dict:
    """Prepare the complete insert for both a read-only preview and the writer."""
    document = initial_document(plugin_key)
    if plugin_key != "@account-policy":
        baseline = legacy_document(db, user_id)
        if plugin_key == LEGACY_SYNC_KEY and baseline:
            document = baseline
        else:
            with db.no_autoflush:
                installed = (
                    db.query(Kind)
                    .filter_by(
                        user_id=user_id,
                        kind="InstalledPlugin",
                        namespace="default",
                        name=plugin_key,
                    )
                    .limit(2)
                    .all()
                    if not plugin_key.startswith("@")
                    else []
                )
            if len(installed) > 1:
                raise PluginWriteError("plugin_write_conflict")
            if installed_kind_id and not installed:
                raise PluginWriteError("plugin_write_conflict")
            if installed:
                parent = installed[0]
                if installed_kind_id and parent.id != installed_kind_id:
                    raise PluginWriteError("plugin_write_conflict")
                installed_kind_id = parent.id
                document = plugin_document(
                    baseline,
                    {
                        "id": parent.id,
                        "name": parent.name,
                        "json": parent.json,
                    },
                )
            else:
                document["spec"]["generation"] = baseline.get("spec", {}).get(
                    "generation", 0
                )
    return dict(
        user_id=user_id,
        plugin_key=plugin_key,
        installed_kind_id=installed_kind_id,
        json=document,
    )
