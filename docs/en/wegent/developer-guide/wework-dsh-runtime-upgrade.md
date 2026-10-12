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
content hash before using that response. Old components without this response and
custom executors still perform a read-only schema query. Incompatible executors
or failed integrity checks must prevent Home migration. Component releases must
preserve the schema response and content hash.

Browser authentication exchanges a token once. Electron saves DSH's Set-Cookie
headers in the existing browser partition, preserving domain, path, expiration,
Secure, HttpOnly, and SameSite attributes.

The `dsh-runtime-upgrade` desktop E2E requires cold and warm startup strictly below
five seconds. It covers existing configuration, legacy app downloads and offline
restarts, new templates, app termination, and process cleanup. A real HTTP server
delivers runtime archives. Linux and Windows CI must transfer these archives with
the shared test build instead of relying on the build user's private cache.
These test assets must not enter production releases.

The memory E2E compares the same task and terminal interface before and after
rendering. Markdown prerenders at most one actual scroll viewport while retaining
indivisible long code blocks and synchronous rendering during rapid scrolling.
Do not increase budgets, skip assertions, or rerun failures to hide defects.
