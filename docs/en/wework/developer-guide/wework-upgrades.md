---
sidebar_position: 61
---

# Desktop upgrades, rollback, and E2E maintenance

Prepare downloads, extraction, component composition, and plugin profiles while the current app remains usable. Offer restart only after the target environment is complete. Switch the host and matching components as one release; keep mutable application data separate.

## Backward-compatible manifests

Keep the existing Electron YAML and `components-<channel>-<platform>-<arch>.json` endpoints and fields. Add `upgradePolicy` to the component manifest. Each target declares `minSourceVersion`; exact source-to-target edges carry delivered-package hashes and upgrade/rollback evidence.

Legacy clients ignore the new fields and continue updating directly to their advertised latest version. Enforcement begins when the client contains the new implementation. Pre-protocol clients are outside the new E2E matrix; do not pin their channel to a bridge.

A minimum version never proves compatibility. The client follows tested edges to the newest reachable version, minimizing hops and confirming each hop separately. A fixed test pair A → B requires B to be newer than A, not globally newest. Recheck revocation immediately before installation. Missing paths must never cause unrestricted updating.

## Release lifecycle

Complete hosts, runtime caches, and prepared profiles live in release slots. Preparation runs using the target package's own entry point. A stable native launcher reads the active pointer and supervises the activation journal without loading target business code.

After confirmation, stop writers, finalize a consistent snapshot, exit, and switch. Both runtime and renderer readiness confirm health. Exit or failure to become ready within 60 seconds enters recovery without an automatic restart loop.

Keep active Goal recovery journals when the executor or app-server stops. A completed previous turn does not complete its Goal; an exit notification or a closed notification stream must not finalize the Goal using that earlier outcome.

Compatible rollback switches directly. Incompatible rollback after the target opened data requires confirmation before snapshot restoration and preserves newer data separately. Failure before opening mutable data can return directly to the previous release. Snapshots cover registered migration-owned stores, including task SQLite/WAL/SHM, desktop preferences, renderer storage, and transcript-sync state. Never restore repositories, cloud records, or personal credentials. Register additional migrated stores together with restore coverage.

Plugin configuration changes invalidate preparation. Recheck before switching instead of repairing large installations after restart.

Confirmed manual rollback records its transaction direction independently. After an interruption, resume rollback instead of treating the target's earlier healthy marker as a new startup confirmation.

Incompatible restoration retains the rejected slot so subsequent cleanup cannot remove newer user plugin data. `preserved-data/<snapshot>/retained-release` identifies it. Preserved data does not expire automatically.

## Maintain three verification layers

| Layer                        | Inputs                                                 | Purpose                                                                                  | Authorizes a production edge                           |
| ---------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Policy and transaction tests | Small manifests and temporary directories              | Floors, routing, revocation, journals, snapshot boundaries                               | No                                                     |
| Mechanism E2E                | Independently built and signed A/B regression packages | Real transport, extraction, Electron/Executor, switching, restoration, task continuation | No                                                     |
| Release-pair E2E             | Immutable delivered source and target archives         | A specific real upgrade and rollback                                                     | Only for the tested platform, architecture, and hashes |

Maintain shared behavior in `app-upgrade.scenario.mjs` and the acceptance version/checkpoint list in `upgrade-suite.mjs`. Normal upgrade, manual rollback, interrupted-rollback recovery, and failed-activation recovery each establish their own fixtures. The shared runner prepares packages once. Upgrade-only runs reuse package A without building an unused generic desktop package. Versions are test data, not branches selecting assertions.

Suite v5 gives host preparation, extraction, and runtime preparation separate five-minute budgets. Phases must advance monotonically; a stalled or failed phase fails verification. Do not apply one operation's budget to every sequential operation combined. The target records profile copying, component preparation, runtime materialization, and profile preparation with start/end timestamps and durations in `logs/release-preparation.log`; retain it in CI artifacts.

Only model services may be replaced. Serve actual package files over real HTTP; use real signature checks, storage, native launcher, and Executor. Fault injection terminates the actual target process. Regression fixtures deliberately exercise incompatible data declarations and snapshot restoration. Build them from source; never rename an archive or rewrite a signed package. Mark results as `regression`; promotion rejects them as release proof.

Each checkpoint first invokes the source package's headless preparation entry to establish an installed client's runtime before UI actions. The target must still extract and prepare its independent slot. After upgrading and rolling back, assert the actual host, Core, plugins, executor, Codex, and DWS paths against that slot's prepared composition; never inherit fixed source binary overrides. Fixture output is separate from formal packages and other checkpoints' applications.

```bash
node --test wework/scripts/upgrade-policy.test.mjs wework/scripts/upgrade-evidence.test.mjs
pnpm --dir wework/electron test src/runtime/release-store.test.ts src/runtime/release-snapshot.test.ts src/runtime/release-profile.test.ts
pnpm --filter wework e2e:desktop -- --parallel-segments upgrade-and-rollback
```

For existing pairs, provide `WEWORK_E2E_UPGRADE_PAIR`, `WEWORK_E2E_APP_BIN`, and `WEWORK_E2E_EXECUTOR_BIN`. Set `WEWORK_E2E_REQUIRE_RELEASE_PACKAGE=1` to preserve original identity/signatures. Change the shared scenario for behavior changes; change pair data for releases. Increment the suite version when acceptance changes materially. Preserve failure logs and fix causes before rerunning. Do not retry, skip, or weaken assertions. Run macOS arm64, macOS x64, and Windows x64 independently. Never commit screenshots, packages, snapshots, sessions, or temporary recovery files.

The `Wework Upgrade E2E` workflow runs the complete three-platform matrix for non-draft PRs under `ci:all` and supports manual dispatch. Keep acceptance versions in `upgrade-suite.mjs`; rebuild fixtures after strengthening assertions instead of reusing old proof.

The existing `app-update-full` checkpoint shares the real-package scenario and retains delayed full-transfer, nonblocking acceptance, no Range/blockmap, and repeated-preparation reuse assertions. CI runs it alongside the four upgrade/rollback checkpoints on each platform. It no longer copies and renames a ZIP or appends bytes to impersonate a new version.

Upgrade edges explicitly record `fromSourceSha` and `toSourceSha`, each matching the delivered package metadata’s `sourceSha`; E2E results record both revisions. Missing or mismatched revisions block promotion, and clients also check the downloaded package revision. Diagnostic log failures must neither block preparation nor replace its original error. Before restoring data after a startup timeout, the native launcher must terminate the complete runtime tree, including writers in independent process groups.

## Native launcher linker

Packaging compiles the launcher through a direct `rustc` invocation, so it must explicitly translate
the target's `CARGO_TARGET_<TARGET>_LINKER` environment variable into `-C linker=<path>`. Uppercase
the target name and replace hyphens with underscores. For Windows x64, set
`CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` to the MSVC `link.exe` path. Direct `rustc` does not
read this Cargo setting; configuring Cargo alone does not prevent name collisions in Git Bash.
Without an explicit linker, preserve Rust's default selection. Invalid explicit settings fail the build.

`node --test wework/scripts/build-launcher.test.mjs` compiles and starts the real launcher with
Git `link.exe` first on PATH, and verifies that invalid linker settings are never ignored. Windows
uses Git's actual `link.exe`; macOS/Linux use a native conflicting program to shadow the default
`cc`. The upgrade E2E workflow runs this test on all three platforms.

## Release promotion

CI workspace dependency caches must also distinguish absolute checkout paths: pnpm records
absolute project paths, so sharing host and container caches triggers reinstallation during service
startup. Main-branch platform E2E jobs populate the container cache. Windows desktop shards consume
packaged dependencies directly; native startup verification installs Electron separately. Parallel
Rust tests use checked-in executable script fixtures to avoid `ETXTBSY` from inherited writer handles.
Persisting a board execution address precedes native session readiness. Confirm that the execution
reaches its model within the runtime startup budget before starting the separate ten-second UI
assertion budget.

`wework/upgrade-policy.json` declares the current target's floor and `sourceVersions`. The initial protocol release may have no incoming edges; subsequent releases must verify at least one. A source may remain fixed rather than tracking the immediately preceding release.

Release jobs create complete portable packages, download declared immutable sources, and invoke the shared checkpoint runner for upgrade and rollback. Evidence binds both versions and package hashes, platform, architecture, suite version, and CI run. Merge only successful edges into the component manifest. Preserve historical edges and their intermediate artifacts. Changed artifacts require a new version and new verification.

Upload immutable target assets and evidence before promoting rolling manifests. Any required pair failure blocks promotion. Compatibility declarations, minimum versions, and unit tests cannot replace real release-pair evidence.

A source may come from another channel, such as Beta to Stable. Verify a new edge under the target channel; import the source node without copying the other channel's edges. Bind evidence to the channel and require an immutable package hash across channels.
