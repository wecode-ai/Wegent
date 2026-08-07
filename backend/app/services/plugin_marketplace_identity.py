# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Marketplace identity helpers shared by plugin publication and app creation."""

PLUGIN_MARKETPLACE_BY_VISIBILITY = {
    "personal": "wework-personal",
    "workspace": "wegent",
    "public": "wework",
}


def marketplace_name_for_visibility(visibility: str | None) -> str:
    return PLUGIN_MARKETPLACE_BY_VISIBILITY.get((visibility or "").strip(), "wegent")
