# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registry for plugins managed by the Wegent Backend."""

from __future__ import annotations

from dataclasses import dataclass

BUILTIN_PLUGIN_OWNER_ID = 0


@dataclass(frozen=True)
class BuiltinPluginDefinition:
    """Describe the required cloud marketplace state for a built-in plugin."""

    name: str
    visibility: str = "public"
    featured: bool = True
    required: bool = True


BUILTIN_SITES_PLUGIN_NAME = "wegent-sites"
BUILTIN_MINI_PROGRAM_PLUGIN_NAME = "wegent-mini-program"
BUILTIN_PLUGINS = (
    BuiltinPluginDefinition(name=BUILTIN_SITES_PLUGIN_NAME, required=False),
    BuiltinPluginDefinition(
        name=BUILTIN_MINI_PROGRAM_PLUGIN_NAME,
        required=False,
    ),
)
BUILTIN_PLUGINS_BY_NAME = {plugin.name: plugin for plugin in BUILTIN_PLUGINS}
BUILTIN_PLUGIN_NAMES = tuple(BUILTIN_PLUGINS_BY_NAME)
