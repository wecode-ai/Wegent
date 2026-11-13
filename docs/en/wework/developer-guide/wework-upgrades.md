---
sidebar_position: 61
---

# Desktop upgrades, rollback, and E2E maintenance

## Codex session provider migration

Reserve stdout for the offline entry's single JSON completion response before migration starts;
writer-lock contention and other diagnostics belong on stderr. Otherwise a successful migration
can fail bridge JSON parsing and roll back unnecessarily. The real contention regression waits
for the diagnostic before releasing the writer and verifies both the complete stdout protocol
and the retained stderr diagnostic.

Session conversion is separate from download-time environment preparation. The target's
`DesktopRuntime.prepareExecutor` invokes its delivered executor's offline
`--workbench-codex-providers-migrate` entry before constructing the managed executor and
admitting queued work or Goal recovery. Never rewrite live sessions during
`release-preparation-cli` prewarming. A Home relocation's `beforeMove` is insufficient:
an already relocated Home does not move again on upgrade.

Migration holds Home process ownership, agent execution and native thread writer coordination
leases. It changes only rollout `session_meta.model_provider` and SQLite
`threads.model_provider` to the logical Wework router, persisted as the single-byte ID `~`.
Replace only the raw JSON provider value and pad unused bytes with JSON whitespace, preserving
the header length and every subsequent byte offset used by paginated/fork history. Never
re-serialize the entire header and shift those references. Older metadata without a saved
provider remains byte-identical and uses native current-provider selection. A versioned Home-local journal
retains original providers and index provenance. Conversation bodies, compression/history
references, permissions, creator accounts, Goal state/budgets and recoverable user commands
are not regenerated. Authentication files, repositories and cloud data are excluded.

Journal v3 stores the original provider's exact JSON value and SHA-256 digests of both header
states, not base instructions or complete header snapshots. Release each header buffer after
processing it. Recovery reconstructs the original provider value and verifies its digest so
permissions, accounts and all other fields cannot change. Validate existing v2 entries one at
a time and atomically compact them to v3 without loading every session header simultaneously.
Interruption before atomic v3 publication restarts conversion of the v2 entries from the beginning.
Existing rollout/index migration progress remains durable; journal compaction itself has no
persisted per-entry cursor.
Leave empty rollouts without published metadata unchanged and retain native metadata-readiness
recovery. A nonempty truncated header, or a missing header already recorded in the pending
journal, still blocks completion. Auxiliary named-Home readers share native process lifetime
leases rather than migrating while a writer is live; they never inherit another Home's auth.
The offline command has no fixed kill deadline. Shutdown cancels it and waits for process exit
before releasing writer ownership. This does not remove an older independent launcher's
activation health budget. Verify the stopped-writer preparation phase and any required bridge
release separately; recoverable migration alone does not certify arbitrary legacy upgrade edges.

Persist intent before mutation; publish rollout files atomically and update indexes in
transactions. Re-entering preparation after interruption must converge, not treat an exception
as completion. Compatible older clients may rewrite the index provider or materialize compressed
history before appending turns. Re-upgrade reconciles indexes against existing sessions without
restoring stale history or discarding those turns. Writers must stop first. Failure cannot admit
the new executor or Goal recovery; activation failure uses existing healthy-release rollback
and startup recovery.

A shared identity never implies shared credentials. API-key and native-account threads replace
the complete provider definition independently. Unscoped account RPCs keep native Codex authentication.
The local router serves the merged catalog using a non-secret catalog credential, never an account
token or task API key. Threads must not inherit that credential or another route's bearer command.
Runtimes with shared routing report `modelProviderRouting: "thread"` in public task and identity
conversation address handles. The owning runtime generates this capability rather than trusting
persisted or caller-supplied values. Composers can switch API and native-account models in the same
thread instead of splitting by logical provider name. Older runtimes without this capability retain
their existing provider-boundary confirmation. The executor still enforces permissions and credentials.
Local catalog discovery has process-owned settings. Native threads retain an explicit Home
`features.api_key_model_discovery` value; local discovery must not enable external API-key discovery.
Before starting the shared process, acquire Home ownership and complete offline migration. Atomically
write the complete merged catalog to a process-owned file inside that Home and load it through native
`model_catalog_json`, avoiding the custom HTTP catalog's 1 MB limit without stripping native
instructions or permission templates. Retain the file until the native process actually exits;
cleanup of unrelated runtime profiles must not remove it.
On Unix, a wrapper's exit does not prove its native descendants have stopped. Reserve the leader
PID until its owned process group exits, then reap the leader and release the Home lease and catalog.
An exit notification alone cannot admit migration. Windows retains its whole-tree termination flow.
On Linux, a zombie main thread can leave workers holding the shared file table. Check the thread
count in `/proc/<pid>/stat` before treating it as a resource-free, single-thread zombie.
Diagnostics retain kernel lock records and the owner's state, process group and thread count;
[`/proc/<pid>/fd` can disappear after the main thread exits](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html).
A real multithreaded Linux regression exits the main thread while a worker holds a file lock,
then verifies that retirement waits for the full thread group and the actual lock release.
Catalog edits use the existing idle restart and active-work confirmation flow. Explicit native
catalog configuration in the Home remains authoritative. Local discovery adds no resident process
and does not serialize model requests from separate threads.
Editing a persisted conversation must use the regular inference resume after `thread/revert`,
restoring its provider, authentication and MCP before `turn/start`. A cold history control context
cannot serve the replacement response directly. Native OpenAI threads retain native WebSocket and
account authentication; public API threads use their HTTP provider. Fill omitted Agent Home identity
from the original conversation without restoring old authentication tokens. Unsaved temporary
threads retain direct execution.
Context compaction also calls the model. After the shared app-server restarts, a cold thread must
restore its complete inference context from the request's freshly resolved model configuration.
A control-only resume must not inherit the process discovery profile's OpenAI compaction v2
capability. Bind model routes and notification subscriptions before resume, retaining the route
registration until native compaction completes. Native accounts retain their own compaction protocol.

Server-created tasks must also retain one stable identity for the initial visible user message
across provisional history, the execution request and native turn presentation bindings. Reconcile
recovered history by identity, never by text: identical prompts can belong to distinct turns.
Recovery acceptance counts answers within assistant messages; a turn-navigation preview is not
another message.
Paused Goals must remain paused across ordinary restarts. Reactivation uses the original task's
persisted execution configuration and existing admission flow. Repeated activation cannot enqueue
duplicate recovery or change queued recovery to running. Native `goal/set` on an unloaded thread
only updates persisted metadata and emits a notification. Activity tracking must account for thread
loading so that this notification cannot block the same thread's recovery. Loaded native Goal
continuations retain their existing concurrency protection.

Bind model routes and notification subscriptions before `thread/resume`, since native Goals can continue
before that RPC returns. Never resubmit original user input or settle an active Goal from a
previous turn's completed outcome.

Acceptance requires delivered-package upgrade, legacy continuation, writes after rollback and
re-upgrade. Cover ordinary/tool history, compressed/compacted history, forks/children, active
Goals, interruption at durable publication boundaries and concurrent account/API-key isolation.
Migration unit tests and native-binary protocol probes do not replace packaged Electron upgrade
and rollback evidence.

## Repairs delivered with the update package

Repairs run through the target package's `release-preparation-cli`, under the same integrity
and signature checks as the host. Do not download and execute separate remote repair scripts.
Each repair declares its supported sources, checks preconditions, supports repeated execution,
records preparation stages, and blocks installation on failure.

Delivered versions `0.6.2`, `0.6.3`, and `0.6.4-beta.1` read the default release store before
the desktop user-data migration, using the wrong directory. Target preparation establishes
directory handoffs to the same physical release store and profile. It verifies the source
package, the executable identity of the parent update host, and live profile ownership. An interrupted activation is archived and cancelled only
when its trial token matches and has no matching attempted, data-opened, healthy, or failed
marker. It never restores snapshots or moves live user data. A compatible repair release must
precede a data-schema upgrade from these clients.

The new bootstrap passes the verified user-data directory internally when handing off to an
affected source. Users need no environment settings. Conflicting paths or identities and
already attempted activations cannot use this cancellation path. Clients unable to download,
extract, or execute target preparation still need a full installer.

Suite v7 runs `app-upgrade` through the normal default layout in an isolated Home, including
rollback. After writers stop, it uses production snapshot, profile-retention, and activation code
to establish an unstarted legacy activation. It checks source usability after restart, automatic
target-owned repair, task preservation and continuation, and rollback. The test runner's initial app environment allows only OS session settings and test control/model services;
product path, binary, identity, and update-source overrides are absent. Suite v10 downloads
actual historical archives without rebuilding or editing them, and uses the default layout
for every upgrade checkpoint. Incompatible pairs retain snapshot-restoration assertions.

`upgrade-policy.json` can declare `requiredDirectUpgrades[targetVersion]`. The repair release
`0.6.4-beta.2` must verify exact-package upgrade and rollback directly from `0.6.2`, `0.6.3`, and
`0.6.4-beta.1`. Deduplicate these with the baseline and previous release, fail publication if
any required source fails, and never retry a failed source to obtain a pass. These requirements
apply only to their declared target, and never authorize an edge without CI evidence.

Prepare downloads, extraction, component composition, and plugin profiles while the current app remains usable. Offer restart only after the target environment is complete. Switch the host and matching components as one release; keep mutable application data separate.

## Backward-compatible manifests

Formal releases build and verify candidate packages, generate update manifests, and only then
create the version tag and Release. Verification or manifest failures do not consume a tag.
macOS arm64 and Windows x64 independently verify real-package upgrades and rollbacks.
macOS x64 adopts arm64's successful version paths and minimum source version without running
release upgrade/rollback E2E. Its records retain x64 package hashes and download URLs, with
`verification.kind=architecture-equivalence`, `arch=arm64`, and both arm64 package hashes
declaring the evidence source. Source and target revisions must respectively match arm64;
missing historical x64 package records block publication. Ordinary PRs do not run packaged
upgrade E2E. Per-architecture release verification rules below apply
to macOS arm64 and Windows x64; macOS x64 uses this explicit architecture equivalence policy.

Keep the existing Electron YAML and `components-<channel>-<platform>-<arch>.json` endpoints and fields. Add `upgradePolicy` to the component manifest. Each target declares `minSourceVersion`; exact source-to-target edges carry delivered-package hashes and upgrade/rollback evidence.

Legacy clients ignore the new fields and continue updating directly to their advertised latest version. Enforcement begins when the client contains the new implementation. Pre-protocol clients are outside the new E2E matrix; do not pin their channel to a bridge.

A verified A → D upgrade/rollback pair grants interval compatibility to published sources B with A ≤ B < D in the same platform, architecture, and channel catalog. B may upgrade directly to D without separate B → D verification. Thus A → B → C → D plus A → D lets a user on B go straight to D. Intermediate direct upgrades are accepted compatibility inferences, not tested pairs; retain actual evidence without fabricating verified edges. A chain alone still requires its intermediate hops unless a direct pair covers the interval.

The target's minimum source version remains a constraint, never permission by itself. Unknown sources, sources below the verified anchor, and sources at or above the target are ineligible. Choose the shortest path to the newest reachable version and confirm each hop separately. A fixed test target only needs to be newer than its source, not globally newest. Existing clients retain their shipped planning algorithm; interval behavior requires a client containing this updater change.

Revoked targets, witness edges, and witness source releases cannot authorize inferred upgrades. An explicitly revoked B → D pair overrides A → D interval coverage; other valid paths remain available. An installed revoked source may still escape through its own non-revoked verified pair. Recheck the same policy immediately before installation. Missing paths must never cause unrestricted updating.

Acceptance version 22 reuses the upgraded real client in the existing `app-rollback` checkpoint to check interval discovery, revocation, and recovery. Its future target manifest is explicitly marked `fixture`; no fixture archive is downloaded and no release evidence is produced for that pair. Real source-to-target upgrade, data retention, and rollback assertions continue independently. Results are retained in `interval-policy-result.json`, with no additional checkpoint or package build.

## One-time credential import and independent rollback storage

Credentials are excluded from migration snapshots. On first use, the security release imports a complete encrypted copy into `protected-credentials` under user data. Legacy credential files, adjacent keys and model configuration remain available to rollback releases. After import, the security release uses only its new store: later writes in either store do not synchronize. Historical copies retain their original protection; this design does not remove historical credential exposure.

Signed package metadata declares `weworkCredentialStorageVersion: 3`, `weworkReadableCredentialStorageVersions: [2, 3]` and `weworkCredentialStorageMode: isolated-copy-once`. This mode does not require a rollback host to read v3, so a separately released bridge is no longer required. Historical targets that migrate the shared file in place retain their reader compatibility check. The source version floor selects candidates; only successful CI evidence bound to exact delivered package pairs authorizes edges.

An empty protected record is also a durable import marker. Clearing values or signing out retains that record, preventing later import of signed-out legacy credentials without requiring OS key access. The selected model file is copied once into the new directory and inline keys become native references; its legacy file and binding remain unchanged. Explicitly selecting a file within the legacy directory or its external binding also copies it before editing; path aliases cannot bypass this isolation. Other external configurations retain direct binding and editing. Failed OS encryption must not publish a partial copy or change legacy files. Asynchronous OS credential APIs keep authorization waits from blocking startup heartbeats.

Suite v25 selects acceptance using native metadata and observed formats. Every storage mode and package pair proves authenticated writes after upgrade and rollback, preserved rollback quarantine and no download without consent; pure v2 pairs do not require re-upgrade. Every v3 pair re-upgrades after explicit confirmation: shared stores authenticate the rollback-written credential, while isolated stores first authenticate a target write and verify unchanged legacy hashes, then authenticate a rollback write and prove the target retains its own updated credential after re-upgrade. That final stage also checks legacy hashes against their values after the rollback write. Isolated targets also use their delivered native model store to select, save and reopen legacy default and externally bound files: the imported key must be readable before replacement, legacy files and bindings stay unchanged and later writes remain independent. The suite also verifies empty capability-manifest restoration, persistence after target restart, and backup retention after rollback.

`upgrade-edge-result.json` records native storage modes and the required stages. Real model HTTP requests authenticate saved secrets. Cloud credentials must decrypt and produce verifiable device signatures; these do not certify real server login or refresh. Missing stages, legacy mutations, repeated import or failed authentication block production edges. Windows independently verifies `app-rollback`; macOS arm64 runs the complete recovery group and x64 retains architecture equivalence. Personal credentials stay outside snapshots and historical packages remain immutable.

## Release lifecycle

### macOS installation and Dock identity

Updates retain the outer `.app` directory and inode at the user's installation URL.
The complete signed payload remains immutable in its release slot. Preparation copies and
verifies it on the installation volume; supervised startup atomically exchanges physical
`Contents` directories after writers stop, then runs the installed executable. Application or
`Contents` symlinks cannot replace this operation. Never edit Dock preferences. An ambiguous
installation, mismatched identity, or unwritable installation volume blocks preparation.
For delivered clients running from a slot, prefer the original URL recorded by the previous
healthy release over unrelated application copies. If that URL still holds an earlier healthy
host, retain its signed program and update that inactive release's program references first.
Preparation replaces no installed program files and preserves both current and prior rollback.

Delivered launchers enter the new payload bootstrap first. Its native helper installs the
selected host, then a native relay spawns the installed application with a fresh PID.
Never re-execute Electron at the same PID: RunningBoard's cached PID version can become
stale and Control Center rejects status-item registration with `process has mismatched pid version`.
The slot entry hides its Dock identity before handoff. The relay retains the legacy supervisor's
process tree until the existing health marker is confirmed or the target exits, preserving
the original activation transaction's failure handling.
A retained legacy program copy references the original source's data owner. Activation uses
the existing snapshot-preservation protocol so delivered cleaners also retain that profile.
After the selected bootstrap loads with the matching version, it takes over recovery forwarding
before opening data. Cached versioned entries in delivered launchers then forward through that
loaded bootstrap to restore the installed host. This does not confirm runtime or renderer health.
Preparation leaves the active source record unchanged; cancellation removes only owned stages.

Rollback writes the source slot to `macos-rollback` before switching `active`. Closing the
activation journal does not prove physical `Contents` restoration completed. While this marker
exists, even an ordinary installed entry must resume recovery instead of opening the rejected
host. The native installer clears it only after the selected bundle is installed; failures retain
it. A later fully healthy activation also clears stale handoff state left by an older source.

Suite v8 additionally checks the actual `NSRunningApplication` URL, bundle identifier, and
outer directory inode after upgrade and rollback. It runs the delivered source cleaner before
continuing the original task after rollback. Suite v10 retains the delivered bootstrap,
release store, and native launcher by downloading old packages without rebuilding them.
Failed activation also enters through the signed versioned source to cover cached legacy recovery.
Mechanism evidence still cannot authorize production edges bound to different package hashes.

Suite v10 also verifies that the system actually hosts the native status item after upgrade
and rollback, beyond Electron having created a `Tray` object. Users with an existing Dock
pin targeting a release slot must remove it and pin the installed application instead;
the application never edits Dock preferences.

`release-package-startup` retains a real first launch without warming the runtime cache.
The Windows CI trace recorded 145 seconds of extraction and a controller connection around
192 seconds after launch. This scenario assigns the existing 180-second budget separately
to component preparation, runtime extraction, Core profile preparation, Core process startup,
and renderer loading. Stalled, regressing, or over-budget phases still fail; preparation logs
never substitute for the real controller connection. Ordinary starts, restarts, and upgrade
scenarios retain their existing wait budgets.

Complete hosts, runtime caches, and prepared profiles live in release slots. Preparation runs using the target package's own entry point. A stable native launcher reads the active pointer and supervises the activation journal without loading target business code.

After confirmation, stop writers, finalize a consistent snapshot, exit, and switch. Both runtime and renderer readiness confirm health. Exit or failure to become ready within 60 seconds enters recovery without an automatic restart loop.

Keep active Goal recovery journals when the executor or app-server stops. A completed previous turn does not complete its Goal; an exit notification or a closed notification stream must not finalize the Goal using that earlier outcome.

Background account-usage reads must wait for runtime proxy initialization. Tray polling must not start an unconfigured native process and force the later proxy update to defer. Subsequent refreshes use the configured proxy environment.

Compatible rollback switches directly. Incompatible rollback after the target opened data requires confirmation before snapshot restoration and preserves newer data separately. Failure before opening mutable data can return directly to the previous release. Snapshots cover registered migration-owned stores, including task SQLite/WAL/SHM, desktop preferences, renderer storage, and transcript-sync state. Never restore repositories, cloud records, or personal credentials. Register additional migrated stores together with restore coverage.

Plugin configuration changes invalidate preparation. Recheck before switching instead of repairing large installations after restart.

Resolve only the active profile's root pointer before cloning, copying the physical directory while preserving internal dependency links. Copying the root link would let rollback preparation mutate the running release's profile. Pass the resolved source profile to older preparation entries as well, so packages with the old clone implementation still receive an isolated copy.

Confirmed manual rollback records its transaction direction independently. After an interruption, resume rollback instead of treating the target's earlier healthy marker as a new startup confirmation.

Incompatible restoration retains the rejected slot so subsequent cleanup cannot remove newer user plugin data. `preserved-data/<snapshot>/retained-release` identifies it. Preserved data does not expire automatically.

## Maintain three verification layers

| Layer                        | Inputs                                         | Purpose                                                                                  | Authorizes a production edge                                  |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Policy and transaction tests | Small manifests and temporary directories      | Floors, routing, revocation, journals, snapshot boundaries                               | No                                                            |
| Mechanism E2E                | Prebuilt real package pairs                    | Real transport, extraction, Electron/Executor, switching, restoration, task continuation | No; fault-injection results cannot authorize production edges |
| Release-pair E2E             | Immutable delivered source and target archives | A specific real upgrade and rollback                                                     | Only for the tested platform, architecture, and hashes        |

Maintain shared behavior in `app-upgrade.scenario.mjs` and the acceptance version/checkpoint list in `upgrade-suite.mjs`. Normal upgrade, manual rollback, interrupted-rollback recovery, and failed-activation recovery each establish their own fixtures. Suite v10 requires prebuilt pairs: the runner fails immediately when artifacts are missing and never compiles, packages, or signs. Reuse the release candidate archive and download immutable historical releases, checking versions, source revisions, and SHA-256. Versions are test data, not branches selecting assertions.

Suite v5 gives host preparation, extraction, and runtime preparation separate five-minute budgets. Phases must advance monotonically; a stalled or failed phase fails verification. Do not apply one operation's budget to every sequential operation combined. The target records profile copying, component preparation, runtime materialization, and profile preparation with start/end timestamps and durations in `logs/release-preparation.log`; retain it in CI artifacts.

Only model services may be replaced. Serve actual package files over real HTTP; use real signature checks, storage, native launcher, and Executor. Fault injection terminates the actual target process. Data compatibility comes from the real packages: incompatible pairs must confirm snapshot restoration and verify preserved newer data. Never rename archives, rewrite package identities, or re-sign historical packages to fabricate a pair. Promotion rejects `regression` results as release proof.

Each checkpoint first invokes the source package's headless preparation entry to establish an installed client's runtime before UI actions. The target must still extract and prepare its independent slot. After upgrading and rolling back, assert the actual host, Core, plugins, executor, Codex, and DWS paths against that slot's prepared composition; never inherit fixed source binary overrides. Fixture output is separate from formal packages and other checkpoints' applications.

```bash
node --test wework/scripts/upgrade-policy.test.mjs wework/scripts/upgrade-evidence.test.mjs
pnpm --dir wework/electron test src/runtime/release-store.test.ts src/runtime/release-snapshot.test.ts src/runtime/release-profile.test.ts
pnpm --filter wework e2e:desktop -- --parallel-segments upgrade-and-rollback
```

Provide a verified `WEWORK_E2E_UPGRADE_PAIR`; the runner resolves the source application and executor without building. Set `WEWORK_E2E_REQUIRE_RELEASE_PACKAGE=1` to preserve original identity/signatures. Default-layout tests with the real application identity require a clean operating-system user; existing native application data stops verification and must never be cleared to run a test. Increment the suite version when acceptance changes materially. Preserve failure logs and fix causes before rerunning. Do not retry, skip, or weaken assertions. Verify macOS arm64 and Windows x64 independently; macOS x64 uses the previously described architecture-equivalence release proof with its own hashes. Never commit screenshots, packages, snapshots, sessions, or temporary recovery files.

Packaged upgrade E2E runs only in the `Wework App` release workflow, including release dry runs. Ordinary PRs and `ci:all` do not run a separate upgrade job. The release gate invokes the shared `upgrade-and-rollback` group; every checkpoint must pass before generating and promoting exact-pair upgrade policy. Keep acceptance versions in `upgrade-suite.mjs`; older-suite proof cannot authorize new edges.

Suite v10 retains downloaded historical entry points without rebuilding them. Before its own child enters application code, the driver routes requests for the default update catalog to real loopback HTTP transport. It supplies no update-feed or other product configuration overrides and does not disable TLS or signature checks. When an older source and the previous published release are both available, their own preparation entries establish the unstarted transaction while retaining profile and component-ownership assertions.

Suite v11 removes `app-update-full`, which duplicated the `app-upgrade` scenario. Delayed full-transfer, nonblocking acceptance, no Range/blockmap, and repeated-preparation reuse assertions remain in the shared scenario executed by all four upgrade/rollback checkpoints. Serial verification rejects a source pair immediately after any checkpoint fails, preserving diagnostics and continuing other policy-required sources. Failed pairs never produce upgrade edges.

Suite v13 folds healthy upgrade and the unstarted-source transaction into `app-rollback`, retaining upgrade, task continuation, manual rollback, and every existing assertion. It removes the duplicate `app-upgrade` prefix. `app-upgrade-recovery` and `app-rollback-recovery` independently exercise real failures. Preparation of a later installed package runs only for the unstarted transaction that consumes it.

Version 0.6.2 and older Beta updaters copy the source host and prepare a rollback profile inside its slot before downloading the target. With no activation transaction, recovery accepts only that installed source's owned host/profile, requires the default live profile and matching prepared configuration revision, and compares both EXE and app.asar hashes against the running parent. Activations retain the original direct ownership checks; copied-host ownership cannot authorize cancellation.

When retaining a macOS rollback source, bind its new slot's `managed-components` to the original immutable program store and relocate `prepared.json` component paths to that slot. Legacy launchers that ignore `componentDataDirectory` then select the same composition. `retainedRelease` keeps the owning slot alive. The legacy unstarted-transaction fixture applies only to delivered legacy selectors. Selectors from 0.6.4-beta.2 correctly start the pending package, so expecting them to keep running the old version is invalid. Every source still runs the complete upgrade, task continuation, and rollback checkpoints.

Physical host and runtime extraction share an isolated child process. Windows uses `%SystemRoot%/System32/tar.exe`; other platforms use locked `node-tar`. Package size, SHA-256, runtime identity, and signing checks remain independent. Source retention, pruning, download, host extraction, signature verification, and target preparation each record their elapsed time; total preparation time must not be reported as extraction time.

Installed-source prerequisites reuse the shared runner's runtime installer. It verifies size and SHA-256 from the original package, installs immutable cache content, and then invokes the source's shipped entry to prepare components and mutable profiles. Cache installation counts toward verification time. Historical packages, signatures, and entry points remain intact, and the first target preparation still consumes its own delivered archive. Core/Workbench roles sharing a fingerprint extract once while validating both role identities.

Formal pair verification reuses runtime files by their complete descriptors, including archive SHA-256, size, version, fingerprint, and role, within the current job's temporary directory. Checkpoints link those files while retaining their own catalogs and mutable profiles. Every use still validates bundled archive size, SHA-256, and role identity. Incomplete or invalid caches fail without extraction retries. Checkpoint cleanup leaves shared content intact; job cleanup removes it, with cleanup time included in total verification.

The target's own preparation entry publishes immutable programs to `.prepared`, addressed by fingerprint, version, delivered archive SHA-256, and size. Later slots verify their delivered archive before linking the same programs. This store never publishes future versions into the source runtime catalog; slots keep private role catalogs and profiles. CI shares this immutable program store between serial checkpoints within one source shard. First preparation and final cleanup both count toward total execution; no extra target prewarming occurs.

CI freezes every selected source before sharding by platform, channel, and source, with at most eight runners. Immutable source runtime caches finish before checkpoint workers start. Warm reads still verify delivered archives without rewriting shared catalogs. Checkpoints stay serial within each pair. Windows shares native legacy application-data paths and Electron singleton identity despite isolated HOME; macOS replaces the shared application bundle. Stable targets verify Stable and Beta; Beta targets verify only Beta. Aggregation requires all selected sources and rejects missing, duplicate, or mismatched evidence. Complete execution targets less than ten minutes, including resolution, downloads, preparation, every scenario, cleanup, uploads, and aggregation. External runner queues are excluded; additional waves under the eight-runner limit still count. Builds and signing are timed separately. Publication rechecks actual completed results. Diagnostics cannot generate edges or certify the complete budget.

Timing reports do not replace exact-package functional verification. When GitHub omits execution-step timestamps, the report marks duration as unknown and lists affected jobs rather than substituting queue time or zero, without blocking actual upgrade tests. Publication still requires successful builds, source shards, and evidence aggregation; missing, failed, or unfinished verification cannot publish.

When upgrade tests quit an installed host, they first confirm command execution started and then require the actual host PID to exit. Quitting closes the renderer that sends control results, so a post-exit renderer acknowledgement is not required; an acknowledgement with a still-running host cannot pass either. Explicit command errors and exit timeouts still fail verification, and scenarios must not force-kill the host to satisfy the exit assertion.

When diagnostics need new packages, `build_only=true` produces immutable inputs for a subsequent non-publishing `verification_run_id` replay. This mode cannot publish, start the upgrade matrix, or generate compatibility evidence. Ordinary releases and default dry runs still require the complete upgrade gate.

`Wework App` accepts `verification_writer_wait_seconds`, an integer from 0 to 600, to observe
an independently owned native writer during stopped preparation. The default is 0 and adds no
ordinary CI wait. Setting 65 adds one 65-second observation to `app-rollback` for each package
pair, without repeating it in the two recovery checkpoints. While the writer remains alive,
the rollout header must stay unchanged and neither the migration receipt nor the trial health
timer may admit activation. Releasing the writer must automatically complete upgrade, task
continuation, and rollback. Nonzero values require a target declaring `afterStopPreparation=1`;
they do not extend product health budgets or weaken assertions. Locally, run the same scenario
with `WEWORK_E2E_UPGRADE_WRITER_WAIT_SECONDS=65`.

Upgrade edges explicitly record `fromSourceSha` and `toSourceSha`, each matching the delivered package metadata’s `sourceSha`; E2E results record both revisions. Missing or mismatched revisions block promotion, and clients also check the downloaded package revision. Diagnostic log failures must neither block preparation nor replace its original error. Before restoring data after a startup timeout, the native launcher must terminate the complete runtime tree, including writers in independent process groups.

Isolated E2E startup diagnostics also monitor the main-thread heartbeat. A five-second stall
captures stack locations once and resumes execution, without reading scopes, arguments, or
source text. Monitoring stops when startup completes.
An uncaught-exception monitor retains errors synchronously
without taking over exception handling or exit behavior.
Windows native child working directories use extended-length paths for both profile validation
and supervised runtime startup. Command execution handles process and stdio errors while
preserving the original spawn failure, stops failed process trees before returning, and waits
for stdio closure on success.
Cleanup must retain `electron-logs` and `release-logs` so the target executor's original logs
distinguish startup failure, health-check timeout, and rollback. Missing logs are not a basis
for guessing changes to startup behavior.

## Native launcher linker

Packaging compiles the launcher through a direct `rustc` invocation, so it must explicitly translate
the target's `CARGO_TARGET_<TARGET>_LINKER` environment variable into `-C linker=<path>`. Uppercase
the target name and replace hyphens with underscores. For Windows x64, set
`CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` to the MSVC `link.exe` path. Direct `rustc` does not
read this Cargo setting; configuring Cargo alone does not prevent name collisions in Git Bash.
Without an explicit linker, preserve Rust's default selection. Empty or invalid explicit settings fail
the build, matching Cargo.

`node --test wework/scripts/build-launcher.test.mjs` compiles and starts the real launcher with
Git `link.exe` first on PATH, and verifies that invalid linker settings are never ignored. Windows
uses Git's actual `link.exe`; macOS/Linux use a native conflicting program to shadow the default
`cc`. Release build verification runs this test before packaging; upgrade scenarios do not repeat compilation.

## Release promotion

CI workspace dependency caches must also distinguish absolute checkout paths: pnpm records
absolute project paths, so sharing host and container caches triggers reinstallation during service
startup. Main-branch platform E2E jobs populate the container cache. Windows desktop shards consume
packaged dependencies directly; native startup verification installs Electron separately. Parallel
Rust tests use checked-in executable script fixtures to avoid `ETXTBSY` from inherited writer handles.
Persisting a board execution address precedes native session readiness. Confirm that the execution
reaches its model within the runtime startup budget before starting the separate ten-second UI
assertion budget.

`wework/upgrade-policy.json` declares only the product's minimum source constraint; no per-release source list is maintained. For each platform, architecture, and target channel, release jobs read the published catalog and retain the previous release's `minSourceVersion` as the fixed baseline X, bounded below by the repository constraint. Stable catalogs contain only Stable versions and floors. Beta catalogs may contain both Stable and Beta and can bootstrap from Stable when Beta has no history. Stable never imports Beta sources or edges.

Release preparation validates that the minimum source is no newer than the target before building,
including explicit version overrides and tag triggers. A stable version sorts after its matching Beta,
so a Beta release cannot use its matching stable version as the minimum source.

CI verifies X to target, then previous release to target, running once if both sources are identical. Each verification must start the actual delivered source, upgrade through the real UI, open the target's main interface, confirm persisted tasks and plugin configuration, continue a task, and roll back to a usable source. Process startup, extraction, and a health endpoint alone are insufficient.

| Fixed baseline X                        | Previous release | Publication decision                                                                       |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| Passes                                  | Passes           | Retain X and publish both verified edges                                                   |
| Fails                                   | Passes           | Require human approval to exclude it, raise the minimum, and publish only successful edges |
| Is not a registered verification source | Passes           | Raise the minimum to the previous release and publish only successful edges                |
| Any result                              | Fails            | Block publication without advancing rolling manifests                                      |

Shards distinguish incompatibility from missing proof. A real-package checkpoint that exits
with a nonzero status produces `status=failed`, `evidence=null` and retained diagnostics, never
successful evidence or an upgrade edge. Aggregation still validates every frozen source result,
package hash, source revision, suite version and CI run. Missing results and signal interruptions
are not compatibility decisions. Only an optional historical baseline may be excluded; previous
release and `requiredDirectUpgrades` failures cannot be overridden.
After reviewing diagnostics and accepting that the old version cannot upgrade directly, set the
`Wework App` input `approved_baseline_exclusions` to comma-separated exact
`platform/arch/channel/version` identifiers, for example `macos/arm64/stable/0.6.2`.
It defaults to empty; aggregation reports unapproved exclusions and blocks promotion. Approval
excludes only the matching failed source, never skips tests, converts failure to success, or
removes existing historical edges and intermediate packages. The CI summary records approved exclusions.

Download, permission, malformed-catalog, and checksum errors abort rather than count as compatibility failures. Revoked releases and regression fixtures are excluded. A genuine initial protocol baseline starts at its own version. Historical catalogs without an eligible previous release are errors, never new baselines. Successful X-to-target verification permits published intermediate sources to upgrade directly under the interval policy. Release CI still verifies the previous release independently and preserves existing edges and bridge packages for other upgrade paths. Interval inference adds no package-pair tests or CI jobs; acceptance version 22 retains the existing real-package upgrade and rollback gate.

Persist the confirmed floor and exact edges in each target channel's `upgradePolicy`. Publish immutable version assets before promoting rolling manifests. The next release reads X from that catalog and retains or raises it automatically, without writing version lists back to source. Stable publication verifies Stable and Beta independently; Beta publication advances only Beta. All platform jobs must succeed before publication. Always retain CI decision summaries and failure logs, distinguishing unavailable baselines, failed verification, and blocked publication; do not retry to hide failures.

Resolve extracted source directories to physical paths before invoking old packages: aliases such as macOS `/var` and `/private/var` must not cause package identity mismatches. Retain candidate packages as CI artifacts before verification and upload successful evidence separately. Publication still requires every platform job to pass and validates the evidence before promoting manifests. Failed runs can then be reproduced with the same signed archive without rebuilding or changing its identity. Retain UI snapshots and failure explanations while excluding credential directories, browser partitions and session storage.

Release jobs create complete portable packages, download the automatically selected immutable sources, and invoke the shared checkpoint runner for upgrade and rollback. Evidence binds both versions and package hashes, platform, architecture, suite version, and CI run. Merge only successful edges into the component manifest. Preserve historical edges and their intermediate artifacts. Changed artifacts require a new version and new verification.

Upload immutable target assets and evidence before promoting rolling manifests. Any required pair failure blocks promotion. Compatibility declarations, minimum versions, and unit tests cannot replace real release-pair evidence.

Beta may import a Stable source only after verifying a new edge under Beta, without copying Stable's edges. Bind evidence to the channel and require an immutable package hash across channels. Stable catalogs reject Beta nodes and Beta minimum versions. Rollback restores the previous healthy local release rather than selecting an older release from the published catalog.

After fixing a test driver, a non-publishing replay can reuse unexpired signed artifacts from a run whose macOS arm64 and Windows x64 builds both succeeded. A failed macOS x64 or Linux build does not block verification of these two platforms. Each verified platform still requires exactly one successful producer and valid provenance, version, artifact digest, and package hashes. Ordinary dry runs and publication still require all four producers to succeed:

```bash
gh workflow run wework-app.yml --ref <test-driver-branch> -f verification_run_id=<original-build-run-id> -f publish_release=false
```

This mode only downloads and verifies existing artifacts. It skips version preparation, compilation, packaging, signing, and publication, and rejects the publish option. The driver comes from the selected branch commit; package versions and identities come from the original artifacts, and evidence remains bound to their actual hashes.

To diagnose a shared startup failure, add `-f verification_checkpoint=app-upgrade` to the replay command. This runs that checkpoint against the previous published release. Focused diagnostics require a non-publishing replay and generate neither upgrade policy nor authorization evidence; normal releases still run the complete suite.

Diagnostic replays record the complete text of early native error dialogs in
`app.log` under `[desktop-e2e-startup-error]`, while preserving the dialog behavior.
Check this record when product logging has not initialized; a controller connection
timeout alone does not identify an upgrade or rollback failure's cause. Unstarted
transaction fixtures use the retained installation's preparation API while keeping
the source version's running components and package identity.

Native launcher handoffs explicitly pass the selected release's owned `userData`
and release root on every platform, including recovery after an interrupted
rollback. Legacy entries may still resolve the store from the parent directory;
directory bridges or macOS-only installation handoffs are insufficient.

If the matching version has been published with different bytes from the original candidate, add `-f verification_release_tag=wework-v<same-version>`. This option is restricted to non-publishing replays: driver dependencies reuse the build artifact, while the target archive and descriptor are downloaded and verified directly from that Release. No package is modified or re-signed. The version must match the input artifact, and the cross-channel package hash check remains enforced.
