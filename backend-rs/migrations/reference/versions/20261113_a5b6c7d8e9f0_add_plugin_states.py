"""Move plugin synchronization documents behind durable plugin identities.

Revision ID: a5b6c7d8e9f0
Revises: f3a7c9e1b2d4
"""

from copy import deepcopy

import sqlalchemy as sa
from alembic import op

revision = "a5b6c7d8e9f0"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None

LEGACY_KEY = "@legacy-v2"


def _tables():
    metadata = sa.MetaData()
    kinds = sa.Table("kinds", metadata, autoload_with=op.get_bind())
    states = sa.Table("plugin_states", metadata, autoload_with=op.get_bind())
    return kinds, states


def _unique_rows(rows, identity):
    result = {}
    for row in rows:
        key = tuple(row[field] for field in identity)
        if key in result:
            raise RuntimeError(
                f"Ambiguous plugin state migration identity={key}; "
                "repair duplicate source records before migrating"
            )
        result[key] = row
    return result


def _runtime_identity(installed):
    document = installed["json"]
    spec = document.get("spec", {}) if isinstance(document, dict) else {}
    source = spec.get("source") or {}
    manifest = spec.get("manifest") or {}
    candidates = (
        source.get("pluginKey"),
        source.get("plugin"),
        manifest.get("name"),
        document.get("metadata", {}).get("name"),
        installed["name"],
    )
    return {
        "installed_plugin_id": installed["id"],
        "name": next(value for value in candidates if isinstance(value, str) and value),
        "marketplace": spec.get("marketplace") or source.get("marketplace"),
    }


def _plugin_document(account, installed):
    source = account.get("spec", {})
    key = str(installed["id"])
    spec = {
        "revision": 0,
        "generation": source.get("generation", 0),
        "runtimeIdentity": _runtime_identity(installed),
        "creationRevisions": {
            installed["name"]: source.get("creationRevisions", {}).get(
                installed["name"], 0
            )
        },
    }
    for field in ("localIntents", "localIntentOrders"):
        spec[field] = {
            instance: {key: deepcopy(slots[key])}
            for instance, slots in source.get(field, {}).items()
            if key in slots
        }
    spec["devices"] = {
        device: {
            "complete_generation": value.get("complete_generation", 0),
            "plugins": {key: value.get("plugins", {}).get(key, 0)},
        }
        for device, value in source.get("devices", {}).items()
    }
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "PluginState",
        "metadata": {"name": installed["name"], "namespace": "plugin-sync"},
        "spec": spec,
    }


def _validate_document(document):
    def mapping(value):
        if not isinstance(value, dict):
            raise RuntimeError(
                "Invalid plugin synchronization document; repair before migrating"
            )
        return value

    def counter(value):
        if type(value) is not int or not 0 <= value < 2**63 - 1:
            raise RuntimeError(
                "Invalid plugin synchronization counter; repair before migrating"
            )

    spec = mapping(mapping(document).get("spec", {}))
    for field in ("revision", "generation"):
        counter(spec.get(field, 0))
    for value in mapping(spec.get("creationRevisions", {})).values():
        counter(value)
    for device in mapping(spec.get("devices", {})).values():
        device = mapping(device)
        counter(device.get("complete_generation", 0))
        for value in mapping(device.get("plugins", {})).values():
            counter(value)
    for instance in mapping(spec.get("localIntentOrders", {})).values():
        for value in mapping(instance).values():
            counter(value)
    for instance in mapping(spec.get("localIntents", {})).values():
        for receipt in mapping(instance).values():
            counter(mapping(receipt).get("intentOrder", 0))


def upgrade():
    bind = op.get_bind()
    kinds = sa.Table("kinds", sa.MetaData(), autoload_with=bind)
    if bind.dialect.name == "mysql":
        duplicate = bind.execute(
            sa.text(
                "SELECT user_id FROM kinds WHERE kind='InstalledPlugin' "
                "AND namespace='default' GROUP BY user_id, "
                "CONVERT(name USING utf8mb4) COLLATE utf8mb4_unicode_ci "
                "HAVING COUNT(*) > 1 LIMIT 1"
            )
        ).first()
        if duplicate is not None:
            raise RuntimeError(
                "Ambiguous plugin state migration identity; "
                "repair duplicate source records before migrating"
            )
    accounts = _unique_rows(
        bind.execute(
            sa.select(kinds).where(
                kinds.c.kind == "PluginSyncState",
                kinds.c.namespace == "plugin-sync",
                kinds.c.name == "account",
                kinds.c.is_active.is_(True),
            )
        ).mappings(),
        ("user_id",),
    )
    installations = _unique_rows(
        bind.execute(
            sa.select(kinds).where(
                kinds.c.kind == "InstalledPlugin", kinds.c.namespace == "default"
            )
        ).mappings(),
        ("user_id", "name"),
    )
    for row in accounts.values():
        _validate_document(row["json"])
    if any(name.startswith("@") for _, name in installations):
        raise RuntimeError(
            "Reserved plugin identity; repair source records before migrating"
        )
    projected = {
        identity: _plugin_document(
            accounts.get((identity[0],), {}).get("json", {}), row
        )
        for identity, row in installations.items()
    }
    identifier = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
    op.create_table(
        "plugin_states",
        sa.Column("id", identifier, primary_key=True, autoincrement=True),
        sa.Column("user_id", identifier, nullable=False),
        sa.Column("plugin_key", sa.String(100), nullable=False),
        sa.Column(
            "installed_kind_id", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("json", sa.JSON(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "user_id", "plugin_key", name="uniq_plugin_states_identity"
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        comment="Plugin-scoped synchronization identities and transaction fences",
    )
    _, states = _tables()
    for (user_id,), row in accounts.items():
        document = deepcopy(row["json"])
        bind.execute(
            states.insert().values(
                user_id=user_id, plugin_key=LEGACY_KEY, json=document
            )
        )
    for (user_id, name), installed in installations.items():
        bind.execute(
            states.insert().values(
                user_id=user_id,
                plugin_key=name,
                installed_kind_id=installed["id"],
                json=projected[(user_id, name)],
            )
        )
    if accounts:
        bind.execute(
            kinds.delete().where(kinds.c.id.in_([r["id"] for r in accounts.values()]))
        )


def _merge_account(target, source):
    target["generation"] = max(target.get("generation", 0), source.get("generation", 0))
    target["revision"] = max(target.get("revision", 0), source.get("revision", 0))
    for name, value in source.get("creationRevisions", {}).items():
        slots = target.setdefault("creationRevisions", {})
        slots[name] = max(slots.get(name, 0), value)
    for field in ("localIntents", "localIntentOrders"):
        for instance, slots in source.get(field, {}).items():
            local = target.setdefault(field, {}).setdefault(instance, {})
            for key, value in slots.items():
                if field == "localIntentOrders":
                    local[key] = max(local.get(key, 0), value)
                elif value.get("intentOrder", 0) >= local.get(key, {}).get(
                    "intentOrder", 0
                ):
                    local[key] = deepcopy(value)
    for device, value in source.get("devices", {}).items():
        local = target.setdefault("devices", {}).setdefault(device, {})
        local["complete_generation"] = max(
            local.get("complete_generation", 0), value.get("complete_generation", 0)
        )
        slots = local.setdefault("plugins", {})
        for key, generation in value.get("plugins", {}).items():
            slots[key] = max(slots.get(key, 0), generation)


def downgrade():
    bind = op.get_bind()
    kinds, states = _tables()
    accounts = {}
    for row in bind.execute(sa.select(states)).mappings():
        _validate_document(row["json"])
        document = accounts.setdefault(
            row["user_id"],
            {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "PluginSyncState",
                "metadata": {"name": "account", "namespace": "plugin-sync"},
                "spec": {},
            },
        )
        _merge_account(document["spec"], row["json"].get("spec", {}))
    for user_id, document in accounts.items():
        document["spec"].pop("legacyActive", None)
        bind.execute(
            kinds.insert().values(
                user_id=user_id,
                kind="PluginSyncState",
                namespace="plugin-sync",
                name="account",
                is_active=True,
                json=document,
                created_at=sa.func.now(),
                updated_at=sa.func.now(),
            )
        )
    op.drop_table("plugin_states")
