"""Materialize account-auth declarations from the immutable package manifest."""

from copy import deepcopy
from typing import Any


def components_with_manifest_account_auth(
    components: dict[str, Any], manifest: dict[str, Any]
) -> dict[str, Any]:
    """Keep scanned components, using the manifest as the auth source of truth.

    Historical scan reports omitted accountAuth. Never merge an old declaration
    back into a release whose manifest no longer declares it.
    """
    result = deepcopy(components)
    declarations = {
        item["slug"]: item
        for item in manifest.get("connectors", [])
        if isinstance(item, dict) and isinstance(item.get("slug"), str)
    }
    for connector in result.get("connectors", []):
        declaration = declarations.get(connector.get("slug"), {})
        connector.pop("accountAuth", None)
        if declaration.get("accountAuth") is not None:
            connector["accountAuth"] = deepcopy(declaration["accountAuth"])
    return result
