---
sidebar_position: 36
---

# Wework DSH runtime upgrades and verification

Wework Core, built-in DSH plugins, and new Smart app templates use official
`0.2.0-rc.2`. Existing Smart apps run with the DSH version declared in their
manifest. `0.1.0-rc.8` downloads on first use and is cached after archive size,
SHA-256, and runtime identity verification. Cached applications work offline;
the legacy runtime is not bundled in the installer.

The build queries the actual packaged Executor's Workbench schema and records
its response in component metadata. Startup verifies both the schema and binary
content hash before using that response. Old components without this response may
reuse the packaged response only when their actual content hash matches. Custom
executors with different bytes still perform a read-only schema query. Incompatible executors
or failed integrity checks must prevent Home migration. Component releases must
preserve the schema response and content hash.
Shared E2E archives must preserve the packaged Executor's original bytes without
stripping it after generating the proof. Verify its actual content hash against
component metadata before publishing the archive.

The main window loads its own initial dependencies. Load the popout page on
demand and import service functions, translators, and small components through
specific collaboration package modules so optional collaboration pages stay
out of the initial bundle. Component composition and read-only Executor
compatibility verification and Codex file validation run concurrently, but all must complete before
startup paths are returned. Node and CLI preparation also overlap component
preparation. Home migration still runs after compatibility verification.

A pnpm patch for `0.2.0-rc.2` `dsh-app-boot` reads and parses its version manifest
once per immutable runtime process. Every plugin compatibility check still runs,
and initial read or parse failures still propagate. Patch configuration, bytes,
and the matching lockfile participate in the runtime build fingerprint, preventing
reuse of unpatched archives. The patch does not apply to `0.1.0-rc.8`, preserving
its existing on-demand download identity.

Browser authentication exchanges a token once. Electron saves DSH's Set-Cookie
headers in the existing browser partition, preserving domain, path, expiration,
Secure, HttpOnly, and SameSite attributes.

The `dsh-runtime-upgrade` desktop E2E requires cold and warm startup strictly below
five seconds. It covers existing configuration, legacy app downloads and offline
restarts, new templates, app termination, and process cleanup. A real HTTP server
delivers runtime archives. Linux and Windows CI must transfer these archives with
the shared test build instead of relying on the build user's private cache.
These test assets must not enter production releases.
Windows measures the startup budget with a release Executor. Native registry APIs
read and expand machine and user PATH while preserving parent-process precedence,
without spawning PowerShell during startup. Windows CI compares native reads with
actual .NET results and verifies that missing values do not block startup. The standard-user
test process must own its `PNPM_HOME` and pnpm store rather than inheriting the CI
administrator's package storage. Stream test logs so evidence survives a hung
process or a failed diagnostic upload.
Marketplace registration verification parses TOML and checks the local type and
complete source path. Valid single-quoted Windows paths must not be rejected
because their serialization differs from JSON double-quoted strings. Minimal Linux E2E artifacts
include standalone Socket.IO and TOML parser bundles so test containers do not
require a local `node_modules` directory.

Closing to the tray retains the main WebView and its control client. Only a real
reload should create a new client and reject responses from the previous client.
After a file tab appears, tests wait for the lazy file panel to display its path
before verifying encoded link resolution. Model tests scroll only rendered
lists: scrolling the hidden advanced list can move its entry button off screen.
Environment summary scroll verification covers both wide docked and narrow
floating layouts, preserving position and the corresponding viewport assertions.
DSH readiness timeouts retain the failed endpoint path and last HTTP error
without printing authentication query parameters.

Explicitly disallow automatic downgrades after selecting the stable or beta
Electron update channel, preventing older releases from downloading and showing
restart prompts in the running app. Drawer animation E2E sets
`prefers-reduced-motion: no-preference` in isolated Electron while production
continues to respect the system's reduced-motion preference.

The memory E2E compares the same task and terminal interface before and after
rendering. Markdown prerenders at most one actual scroll viewport while retaining
indivisible long code blocks and synchronous rendering during rapid scrolling.
Do not increase budgets, skip assertions, or rerun failures to hide defects.

Windows Git workspace clones explicitly enable `core.longpaths`; native Windows CI covers real repositories beyond the legacy path limit. Runtime work indexes still use atomic replacement, with bounded waiting only for Windows sharing conflicts. Permanent persistence failures propagate to transcript restore and acknowledgement callers. New restore state is published and the previous conversation directory is cleaned only after the index is durable.

The existing macOS verification guard requests user activity and retains display and idle-sleep assertions for the test lifetime, releasing them on exit. An AC-only system-sleep assertion does not prevent battery-powered DarkWake from returning to maintenance sleep. The guard changes neither system settings nor scenario deadlines or performance budgets.

Formal macOS package verification runs `dsh-runtime-upgrade` first, preserving both strict five-second cold-start and restart assertions against the signed and notarized package. System security scans of temporary ad-hoc packages remain failed measurements; warming the app or subtracting scan time cannot turn them into a passing result.

Desktop PR and Merge Queue builds consume the Executor binary artifact for the same commit and event. Packaging can overlap the producer build without requiring its OCI tag to publish within the short registry wait window. Fork Backend Rust builds remain source builds; other paths retain the existing OCI cache.
