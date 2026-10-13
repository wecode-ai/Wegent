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

Initial cloud restoration reuses the parent preferences provider’s first loaded
snapshot instead of reading the same serialized store twice. A standalone cloud
provider keeps its original read path. Restoration runs once; later preference
updates do not overwrite the current connection. The initial generation and
disconnect guard still protect disconnects and new connection attempts made
while preferences are loading.

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

Managed Git worktree commands enable Windows long paths through `-c core.longpaths=true`. Deletion, restoration, and snapshot-reference cleanup run from the common Git directory's parent using a relative directory name, avoiding Git's literal `GIT_DIR` length guard. Git for Windows discovers the linked worktree's `HEAD` and common Git directory before loading repository configuration, so working directories and these discovery paths must remain within `MAX_PATH`; the command-line long-path setting cannot remove this prerequisite. Native coverage preserves that boundary while checking real blob objects and source and target tracked-file paths beyond 260 UTF-16 units through preparation, modification, snapshot deletion, restoration, and permanent deletion. Device file paths reuse the existing absolute-path contract, preserving Windows canonical drive and UNC roots so generated images are not read as POSIX paths.

The existing macOS verification guard requests user activity and retains display and idle-sleep assertions for the test lifetime, releasing them on exit. An AC-only system-sleep assertion does not prevent battery-powered DarkWake from returning to maintenance sleep. The guard changes neither system settings nor scenario deadlines or performance budgets.

Formal macOS package verification runs `dsh-runtime-upgrade` first, preserving both strict five-second cold-start and restart assertions against the signed and notarized package. Additional native startup time in temporary ad-hoc packages remains part of failed measurements; warming the app or subtracting that time cannot turn them into a passing result. Without stack or system-log evidence, it must not be attributed directly to security scanning.

Desktop PR and Merge Queue builds consume the Executor binary artifact for the same commit and event. Packaging can overlap the producer build without requiring its OCI tag to publish within the short registry wait window. Fork Backend Rust builds remain source builds; other paths retain the existing OCI cache.

DSH UI native dynamic imports load the build-generated CSS of the entry and its static dependencies before publishing the module, sharing stylesheet loads across modules. Stylesheet failures propagate directly instead of re-importing the full collaboration package. Long drafts scroll inside the constrained editor viewport while attachments and the toolbar retain their positions.

Formal release assets use the same cache-path resolver as the runtime archive producer, collecting the latest Core, latest Workbench, and on-demand legacy archives for both default caches and relative overrides while preserving Executor bytes and component content hashes.

Core profile preparation overlaps host bridge startup after the Executor schema compatibility gate. Native processes start only after the bridge environment is ready. Cancellation and shutdown await in-flight preparation, restarts prepare fresh state, and Smart app runtimes retain their bridge environment.

The active task surface loads registered Home modules alongside the Core app module, sharing module and stylesheet promises. Hidden tasks and project boards do not request Home modules. Loading errors propagate to page error handling, and startup readiness still waits for the actual page to finish.

The initial task surface does not statically load project boards, task boards, connection settings, or the mobile layout. Load these modules only when their branches are displayed, preserving board styles and interactions. Mobile browsers still use the mobile layout; narrow Electron windows retain the desktop layout. Loading placeholders do not report startup readiness.

Feedback and Smart app archive libraries load only when compression or extraction is requested. Main-window initialization no longer loads unused archive dependencies; archive contents and security validation remain intact.

The CI-covered `harness-apps` scenario uses an isolated client cache and verifies that startup does not download the legacy runtime. The first legacy Smart app downloads one archive. Marketplace, imported, and directory installations must each report the manifest-required `0.1.0-rc.8`, matching the cached runtime identity and actual DSH package version. Later instances reuse that archive while retaining the original stop, reopen, and page-state assertions.

The app updater prepares alongside runtime configuration and finishes before host capabilities are registered, reusing one service instance. Initialization errors still prevent startup instead of hiding update failures.

Core profile preparation does not wait for updater initialization. The complete host pipe still uses the sole update service, and startup waits for that pipe. Shutdown awaits and releases a pipe whose preparation is pending. Initialization failures preserve the original error and prevent Executor and Core startup.

First-run workbench mode detection persists developer mode after confirming any executable development tool, without waiting for absent tools to scan the entire PATH. Confirmation cancels the remaining candidate scans; in-flight filesystem operations finish naturally without starting further unnecessary access or stat calls. When every tool is absent it still waits for all results. Existing modes are not probed again; Windows PATHEXT, directory exclusion, and the macOS Git placeholder check remain intact. This wait optimization does not change the real cold-start measurement window or budget.

Renderer phase logs distinguish completed module imports, stylesheet start and completion, and the actual surface-ready signal. Logs use fixed module allowlists and monotonic timestamps in `runtime-launch.log`, without task, file, or authentication data. Phase separation retains the original loading waits and error propagation; loading placeholders cannot count as readiness.

Core CPU diagnostics require explicit `WEWORK_E2E_CORE_CPU_PROFILE=1`. Node starts sampling before the official DSH entry and immediately saves an allowlisted module and operation summary when the actual endpoint becomes ready. It writes no private paths, arbitrary functions, or raw profiles; Windows forced termination preserves the summary. A new `before-endpoint` marker requires a persisted summary for that process; missing summaries fail diagnostic pruning. Legacy exit-profile omissions during forced termination are counted separately. The cleanup script summarizes existing local raw profiles using process identity and the endpoint clock, then deletes them before upload. The sampling window excludes earlier host startup. Diagnostic overhead remains inside the original startup budget, without warming or subtracting time; strict verification with the default configuration remains required.

Diagnostic mode awaits Inspector's actual asynchronous callbacks: sampling starts before DSH loads, and endpoint markers are published only after sampling stops and the summary is written. Repeated completion calls share one Promise. Failures record only fixed stop, summarize, or write phase codes; strict pruning still rejects missing summaries. Normal mode retains synchronous endpoint publication.

Formal macOS signing retains timestamps, hardened runtime, entitlements, and strict verification. The shared signing entry repeats the original request at most three times only for explicit service-unavailable or required-timestamp-missing errors, without other errors in the output. Permission, signing, and verification errors fail immediately. Persistent timestamp failure prevents publication of signed caches or the component manifest. [Apple DTS's explanation](https://developer.apple.com/forums/thread/654794) supports classifying the missing timestamp as a request failure; it does not establish a global service outage during this run.

Executor polling discovers unconfirmed work for the current runtime before locking the selected execution by primary key and rechecking its identity and status. Empty polls do not lock other installations' executions or index ranges. Matching work retains its existing lease, redelivery, and terminal-state protections, preventing unrelated polls from blocking runtime-preflight failure persistence.

When an active Goal continues automatically, a Codex process exit or closed notification stream must not reuse the previous turn's success. Executor shutdown retains recovery records. An isolated subprocess crash ends the current running state and reports failure while retaining Goal records for explicit recovery or the existing queue after Executor restart. Already queued recovery cannot be enqueued twice; ordinary business errors retain their existing handling.

Plugin-management E2E retains the complete packaged-resource hash assertion and additionally records changed entries by relative path, type, and SHA-256, without file contents or private absolute link targets. Page load completion does not replace module execution and controller connection; diagnose resource changes and module failures from concrete logs.

Core profiles no longer create a redundant `web` link to packaged App assets. Static serving continues to use the existing component through `WEWORK_APP_WEB_ROOT`. On Windows, Electron Node synchronous directory removal traverses junctions, allowing pnpm replacement of the old package to empty packaged assets. Existing profiles migrate through a layout revision, unlinking only the legacy App `web` alias before rebuilding or resetting packages while retaining user plugins and settings. Later startups reuse the current layout. pnpm imports regular files into separate directories without recreating that junction; installation, update, and removal retain the existing resource-integrity assertions.

Windows release verification selects the actual component composition using the current Core profile's `corePluginsFingerprint`, allowing backing and historical directories to coexist, and checks that the selected composition's `wework-app/web/assets` uses a Junction without requiring symbolic-link privileges, and that the Core profile contains no dangerous `web` alias. The file-tree API reuses the existing path normalization when serializing Windows extended prefixes; internal filesystem safety checks retain canonical paths. A real-directory regression verifies readable output paths alongside the original path-equality assertion.

Runner selectors and local APIs import pure routing functions through the collaboration package's `agent-form/runnerRouting` entry. Environment and model selection retain their existing behavior while the initial page avoids statically loading the project platform and Issue editor through the package barrel. Startup readiness still waits for the actual page, modules, and data.

Shared scrolling types reference `MessageListProps` through a full `import type`, so feedback diagnostics load only the code needed for scroll geometry.

Candidate schemas for overridden Executor paths use one binary-content hash per check. A match uses the supplied proof; a mismatch queries the actual binary schema. Cached or explicitly required proofs are still revalidated on every independent check, and modified binaries continue to block startup.

After freezing splash pixels, wait for the window's actual `closed` event before encoding and persisting the PNG. The close marker records the real window closure without waiting for test evidence to reach disk. The close Promise still awaits persistence, and capture, encoding, or write errors still reject. Existing screenshots, readiness ordering, and the strict startup budget remain intact.

Transcript outbox tables, indexes, and existing-column migrations initialize in one atomic transaction while retaining WAL, FULL synchronization, and busy-wait requirements. Failed initialization rolls back and closes the connection, preserving existing records without leaving partially created tables.

Automatic Goal continuation events advance the active turn through the sole lifecycle coordinator. Late settlement of an older turn cannot end the new turn, and turn settlement cannot end an active Goal. Remote collaboration E2E explicitly selects its required remote environment through the real agent editor rather than a project pool that allows multiple devices, retaining every remote-claim assertion.

The Markdown renderer loads only when content is displayed, preserving the public component and props. The shared message list uses a local Suspense boundary with its existing loading placeholder, preventing the initial parser load from hiding the whole page, releasing the built-in browser's native view, or interrupting the composer. Its content-ready callback stays inside that boundary and requires committed messages. A selected task cannot report startup readiness while its transcript is loading or its virtual list has not committed visible content. Bootstrap and Harness recovery placeholders cannot report readiness either; an active Harness terminal waits for its snapshot to finish writing, while failed recovery waits for the actual error surface. Empty-task startup avoids the parser; real messages, plans, and subagent conversations retain the original renderer. Smaller build dependencies do not replace strict cross-platform startup measurements.

Startup imports collaboration components, translations, and pure model helpers through their corresponding module entry points, preserving existing package-root exports and component identity. Replacing 18 startup aggregate imports with precise entry points to the existing implementations reduced the static JavaScript closure of the application entry, Core, and Developer Home from 5,740,346 to 5,151,628 bytes in Vite production builds of the same source revision: 588,718 fewer bytes, with 18 project-platform modules removed from that closure. These totals use the actual emitted chunks and their static dependency sets; startup duration remains subject to the existing real cold-start assertion below five seconds. File editors, file trees, diffs, and terminals retain their existing on-demand entry points, without migrating caller behavior or props.

Initial chunk assignment names only the main entry, removing redundant module-graph traversal and letting Rolldown group live dependencies recursively. This prevents optional icons exported by the Lucide barrel from being promoted into the initial bundle. Pure icon modules referenced by at least two entries form a shared chunk; dynamic icons retain their existing entry. Same-source production builds reduce the main page’s static JavaScript closure from 2,851,300 to 2,357,349 bytes, saving 493,951 bytes and reducing its icon modules from 1713 to 58; both have three static chunks. The actual initial task screen also loads Core and Developer Home. The union of these three entries’ static closures decreases from 5,151,626 to 4,694,367 bytes, saving 457,259 bytes, with 198 icon modules and 78 to 79 static chunks. Report these scopes separately instead of conflating the main entry with the complete initial task screen. Real compiler regressions verify required static dependencies, shared icons, and deferred entry reachability; actual benefits still require the real cold-start assertion.

Core readiness diagnostics reuse existing startup events to record fixed phases and statuses for authentication exchange, browser-cookie installation, and endpoint readiness without recording URLs, tokens, or cookies. The endpoint phase includes the authentication phases. Logging preserves cookie-installation ordering, the requirement that every endpoint succeeds, and the startup budget.

When Core CPU diagnostics are enabled, the outbox additionally records monotonic timestamps and durations for initialization, database opening, PRAGMAs, and the schema transaction. Logs contain only fixed phases and statuses, without database paths, SQL, or error contents. Disabled diagnostics retain the original operations and error propagation. Sampling attribution does not replace actual phase-duration evidence.

Terminal plugin route registration and its empty session manager do not load the native `node-pty` module. Starting a terminal loads the same dependency through the standard Node loader, retaining synchronous spawn, existing error responses, and paired-resource requirements. Real Node and Electron verification must create, exchange data with, and close a PTY.

Windows failure diagnostics preserve the original errors and cleanup. Git worktree diagnostics add only fixed error forms, known directory roles, UTF-16 lengths, and existence flags, without paths or stderr. Desktop failure snapshots record process exit states and isolated Codex SQLite file metadata. Database checks open disposable byte copies only; original DB/WAL/SHM files remain unchanged, output contains fixed statuses and migration versions, and copies are removed. Copies can span concurrent writes and cannot replace causal evidence for the original initialization error. E2E Executor HTTP diagnostics separately record request arrival, body completion, and active SSE counts without request content. These diagnostics do not establish that the underlying failures are fixed.

Codex app-server restart holds the client state lock through old process-tree
termination and confirmed exit before admitting a replacement, preventing old
and new processes from overlapping on the same SQLite Home. Cancellation retains
the retiring process so subsequent requests continue waiting for exit. Termination
or exit-confirmation failures propagate rather than reporting successful restart.
Windows process-tree termination runs in a blocking task, preserving existing
active-turn, pending-request, and forced-restart semantics.
