---
sidebar_position: 5
---

# Marketplace UI Guidelines

The marketplace follows the complete Wework design contract in
[`wework/DESIGN.md`](../../wework/DESIGN.md). This document only defines
marketplace-specific behavior.

## Information architecture

The plugin workspace has two primary views:

- **Marketplace** for discovery, source selection, search, filtering, and
  installation.
- **Installed** for enablement, component settings, updates, sharing, and
  removal.

Plugin details should expose identity, provenance, version, included
capabilities, authorization requirements, and a clear primary action. Do not
repeat the same metadata in multiple panels.

## Marketplace sources

Cloud and local marketplaces can appear together. Source tabs must have stable
identities and preserve the user's selection. A failed source must show its own
error without hiding healthy sources.

Plugin identity is `<plugin-name>@<marketplace>`. Never merge entries by display
name or plugin name alone. A local Wegent materialization may be deduplicated
against its cloud record; an OpenAI or user-added marketplace entry with the
same name remains distinct.

User-added sources must display their repository or configured marketplace name.
Built-in source labels must use localized strings, not persisted display text as
state.

## Catalog behavior

- Preserve useful results during refresh.
- Search names, descriptions, source labels, and capabilities.
- Keep installation and update states visible without relying on color alone.
- Disable duplicate actions while a request is pending.
- Explain whether an action affects the account, the current device, or all
  registered devices.
- Keep local marketplace browsing available when the cloud is disconnected.

## Installation and authorization

Installation is complete only after the current device confirms
materialization. Show pending and failed device states explicitly.

If a connector requires authentication, present the appropriate browser or QR
flow before installation or use. Credentials remain in the device credential
store. Cancellation and failure must leave the plugin in a recoverable state.

## Sharing and publishing

Personal plugins may expose publish and share actions when allowed by backend
capabilities. The UI must distinguish:

- private ownership;
- selected recipients;
- workspace visibility;
- public visibility;
- pending, approved, and rejected submissions.

Do not infer permission from labels or hide backend authorization errors.
Revoked recipients must lose access immediately even when device cleanup is
pending.

## Accessibility and localization

- All interactive controls require descriptive `data-testid` values.
- Source tabs, dialogs, menus, and plugin rows must support keyboard navigation.
- Focus must be visible and restored after dialogs close.
- All user-visible copy must exist in both Wework locale files.
- Test long English and Chinese labels at desktop and mobile widths.
- Use status text or icons in addition to color.

## Verification

Run focused unit tests, TypeScript checks, formatting, and linting. Changes to
desktop behavior or Tauri integration also require the isolated real-Tauri
workflow documented in `wework/AGENTS.md`.
