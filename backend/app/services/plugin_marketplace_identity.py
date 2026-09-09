# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Marketplace identity helpers shared by plugin publication and app creation."""

import hashlib

PERSONAL_CATALOG_PREFIX = "personal/"
ENTERPRISE_CATALOG_NAMESPACE = "enterprise"
OFFICIAL_CATALOG_NAMESPACE = "wework-official"

PLUGIN_MARKETPLACE_BY_VISIBILITY = {
    "personal": "wework-personal",
    "workspace": "wegent",
    "public": "wework",
}


def marketplace_name_for_visibility(visibility: str | None) -> str:
    return PLUGIN_MARKETPLACE_BY_VISIBILITY.get((visibility or "").strip(), "wegent")


def personal_catalog_namespace(owner_user_id: int) -> str:
    if owner_user_id <= 0:
        raise ValueError("Personal catalog identity requires an owner user ID")
    return f"{PERSONAL_CATALOG_PREFIX}{owner_user_id}"


def catalog_namespace_for_visibility(visibility: str, *, owner_user_id: int = 0) -> str:
    if visibility == "personal":
        return personal_catalog_namespace(owner_user_id)
    if visibility == "public":
        return OFFICIAL_CATALOG_NAMESPACE
    return ENTERPRISE_CATALOG_NAMESPACE


def installed_plugin_kind_name(catalog_namespace: str, slug: str) -> str:
    identity = f"{catalog_namespace}:{slug}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:10]
    return f"{slug[:89]}-{digest}"
