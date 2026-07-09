---
sidebar_position: 33
---

# Codex Plugin Runtime

Wework's plugin feature is compatible with Codex plugins, skills, and apps. The plugin pages handle discovery, installation, creation, and management; the chat runtime passes user-selected skills and apps to the Codex app-server as structured mentions instead of treating display text as plain prompt content.

## Page Entry

In the desktop sidebar, the plugin entry is fixed as the third primary action: New Chat, Search, Plugins, then Cloud Work. Inside the plugin page:

- The header shows marketplaces, installed plugins, and search.
- The top-right refresh button reloads the current marketplace.
- The create entry opens a Codex plugin creator-style page.
- The management entry opens the installed plugin, skill, and app enablement and uninstall view.

Plugin marketplaces are not split into local and cloud modes. Wework lets users add multiple named marketplaces from GitHub repositories, remote addresses, or local `marketplace.json` files/directories. When no marketplace exists, Wework shows a welcome page that guides the user to add a marketplace or open management.

## Marketplace and Install

Marketplace data is read through the Codex app-server exposed by the local executor. Remote GitHub marketplaces are cloned into a local cache directory, and later reads use the cached marketplace data and plugin folders. Install, uninstall, refresh, and marketplace removal all go through Codex app-server methods; Wework does not maintain a separate installed-plugin state.

The frontend only stores the user-configured marketplace list and current marketplace selection. Installed status, skill/app availability, and plugin detail contents come from Codex app-server responses.

## Separate Codex Home

Wework uses a separate Codex home so it does not write directly into the user's command-line Codex config directory. By default this is the `codex` child directory under the executor home, and it can be overridden with `WEGENT_CODEX_HOME`.

To reuse the user's existing login, Wework links the user's `~/.codex/auth.json` into the Wework Codex home. If the target is a stale symlink, it is removed and recreated; on non-Unix systems the auth file is copied. Plugins, marketplace caches, and Wework runtime config remain under Wework's own Codex home.

## Chat Runtime

When a user selects a skill or app in the composer, the editor inserts a structured badge and serializes it on submit as a Codex app-server-compatible mention:

- Skills use `[$name](skill://path)`.
- Apps use `[$name](app://connector_id)`.
- Plugins use `[$name](plugin://plugin_id)`.

Before sending `turn/input`, the executor parses those markdown mentions and builds Responses API-style `input` text elements. This lets Codex receive the actual skill/app/plugin reference instead of only the display text.

Plugins that the user has not selected are not injected into ordinary conversations automatically. Installing a plugin only makes its skills and apps discoverable to the Codex app-server; activation still depends on Codex app-server plugin state and the user's selection in the conversation.

## Backend Upload

Backend provides helper support for parsing and uploading installed plugin packages, including Codex plugin manifests, skills, and app metadata. That parsing path is for server-side storage and display only; it does not replace the local Codex app-server as the source of truth for Wework installation state.
