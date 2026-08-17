---
sidebar_position: 23
---

# Wework Plugin Icon Guide (wework-plugins)

For maintainers of [wework-plugins](https://github.com/wecode-ai/wework-plugins) (and internal plugin repos): how to ship `logo` / `logoDark` so icons stay readable in light and dark UI.

The Wework client only applies **generic** behavior: theme-based selection, a light/dark icon-slot pad, and a neutral default when no logo exists. Brand artwork must live in the plugin package. Do not rely on the client guessing icons by plugin name.

## 1. What to change

Per plugin directory (for example `plugins/dingtalk/`):

```text
plugins/<slug>/
├── .codex-plugin/
│   └── plugin.json          # interface.logo / logoDark / composerIcon
└── assets/
    ├── app-icon.svg         # or logo.png: light / shared artwork
    └── app-icon-dark.svg    # optional: dark-theme artwork
```

Declare paths in `.codex-plugin/plugin.json` under `interface` (relative to the plugin root):

```json
{
  "name": "dingtalk",
  "version": "1.0.0",
  "description": "…",
  "interface": {
    "displayName": "DingTalk",
    "shortDescription": "…",
    "logo": "./assets/app-icon.svg",
    "composerIcon": "./assets/app-icon.svg",
    "logoDark": "./assets/app-icon-dark.svg"
  }
}
```

| Field | Required | Role |
| --- | --- | --- |
| `logo` | Strongly recommended | Primary mark for marketplace, installed list, detail (preferred in light theme) |
| `composerIcon` | Optional | Compact composer icon; falls back to `logo` |
| `logoDark` | When needed | Preferred in dark theme; otherwise dark falls back to `logo` / `composerIcon` |

Supported relative asset types: `.png` / `.jpg` / `.jpeg` / `.svg` / `.webp`.

## 2. When `logoDark` is required

| Case | Need `logoDark`? |
| --- | --- |
| Color brand mark that reads on both light and dark pads | **Optional**; reuse the same file for `logo` (and `composerIcon`) |
| Near-black / dark mono mark (classic GitHub Octocat style) | **Required**: ship a light-on-dark variant as `logoDark` |
| White stroke / light mark on transparency | Check light theme: if it washes out, put the dark variant in `logo`, and add a light `logoDark` for dark UI if needed |
| No `logo` at all | Wework shows a neutral default; official plugins should add `logo` before publish |

Rule of thumb: open marketplace cards, the Slash `/` menu, and composer plugin previews in both **light** and **dark** Wework themes. If either theme fails, fix the package assets—not the client.

## 3. Steps in wework-plugins

1. Add the light (or shared) icon under `plugins/<slug>/assets/`.
2. If dark theme contrast is poor, add a dark-specific file (prefer `*-dark.svg` / `logo-dark.png`).
3. Update `interface.logo`, `composerIcon`, and `logoDark` in `plugin.json` (paths starting with `./assets/`).
4. Bump the plugin SemVer `version`.
5. If the slug is already published to the Wegent marketplace, republish / re-seed with the existing official flow (see [Plugin Marketplace Developer Guide](./wework-plugin-marketplace-dev.md)), then update or reinstall on a device to verify.

Public seed slugs stay in sync with Wegent `backend/scripts/seed_wework_public_plugins.py`. Internal plugins use your workspace publish path (for example `publish_official_plugin.py --visibility workspace`).

## 4. How the client resolves icons

Dark theme order: `logoDark` → `logo` → `composerIcon`.  
Light theme: `logo` → `composerIcon`.  
None: neutral default icon.

In dark Composer surfaces, a **soft translucent light pad** is applied only when the package has no usable `logoDark` and the UI falls back to the light `logo` / `composerIcon`. Packages with `logoDark`, and the neutral default icon, get no pad. Package `logo` / `logoDark` remain the brand source of truth.

## 5. Checklist

- [ ] A readable primary icon exists under `assets/`.
- [ ] `interface.logo` points at it (set `composerIcon` too when practical).
- [ ] `logoDark` and its file are added when dark contrast is insufficient.
- [ ] Paths are package-relative and included in Git / the release ZIP.
- [ ] `version` is bumped and publish or dry-run is done.
- [ ] Verified in Wework light + dark: marketplace, installed list, Slash menu, composer preview.

## 6. OpenAI upstream mirrors (including GitHub)

Wegent syncs OpenAI official packages as a **passthrough** — it does not rewrite
`logo` / `logoDark`, connectors, or copy. Dark icons for plugins such as GitHub
only appear when the official package ships `logoDark`. Reinstalling installs
whatever the official package currently contains.

## 7. Out of scope

- Do not add brand-specific dark SVGs inside the Wegent / Wework repo.
- Do not rely on client light pads to replace a missing `logoDark`.
- Do not invent `composerIconDark`; use `logoDark` for dark brand artwork.
