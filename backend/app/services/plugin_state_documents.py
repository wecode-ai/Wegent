"""Pure projections shared by lazy initialization, backfill and rollback."""

from copy import deepcopy
from typing import Any


def initial_document(plugin_key: str) -> dict:
    document = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "PluginState",
        "metadata": {"name": plugin_key, "namespace": "plugin-sync"},
        "spec": {"revision": 0, "generation": 0},
    }
    return document


def runtime_identity(installed: dict[str, Any]) -> dict[str, Any]:
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


def plugin_document(
    account: dict[str, Any], installed: dict[str, Any]
) -> dict[str, Any]:
    source = account.get("spec", {})
    key = str(installed["id"])
    spec = {
        "revision": 0,
        "generation": source.get("generation", 0),
        "runtimeIdentity": runtime_identity(installed),
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


def validate_document(document: Any) -> None:
    def mapping(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise RuntimeError(
                "Invalid plugin synchronization document; repair before migrating"
            )
        return value

    def counter(value: Any) -> None:
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


def merge_account(target: dict[str, Any], source: dict[str, Any]) -> None:
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
