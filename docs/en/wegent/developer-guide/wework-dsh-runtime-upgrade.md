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
because their serialization differs from JSON double-quoted strings.

Explicitly disallow automatic downgrades after selecting the stable or beta
Electron update channel, preventing older releases from downloading and showing
restart prompts in the running app. Drawer animation E2E sets
`prefers-reduced-motion: no-preference` in isolated Electron while production
continues to respect the system's reduced-motion preference.

The memory E2E compares the same task and terminal interface before and after
rendering. Markdown prerenders at most one actual scroll viewport while retaining
indivisible long code blocks and synchronous rendering during rapid scrolling.
Do not increase budgets, skip assertions, or rerun failures to hide defects.
