"""Materialize account-auth declarations from the immutable package manifest."""

from copy import deepcopy
from typing import Any

from app.services.plugin_package_parser import plugin_package_parser


def components_with_manifest_account_auth(
    components: dict[str, Any], manifest: dict[str, Any]
) -> dict[str, Any]:
    """Keep scanned components, using the manifest as the auth source of truth.

    Historical scan reports omitted accountAuth. Never merge an old declaration
    back into a release whose manifest no longer declares it.
    """
    result = deepcopy(components)
    declarations = {
        connector.slug: connector.accountAuth
        for connector in plugin_package_parser._parse_connectors(manifest)
    }
    for connector in result.get("connectors", []):
        declaration = declarations.get(connector.get("slug"))
        connector.pop("accountAuth", None)
        if declaration is not None:
            connector["accountAuth"] = declaration.model_dump(exclude_none=True)
    return result
