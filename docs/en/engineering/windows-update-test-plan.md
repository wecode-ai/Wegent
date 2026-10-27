---
sidebar_position: 40
---

# Complete Windows version updates and verification

## Outcome and scope

In-app Windows updates download complete versions without opening NSIS. A candidate becomes active only after both the local runtime and workbench renderer start successfully. Download, validation, shutdown, or startup failures retain the last confirmed version. Tasks, conversations, authored plugins, and project files remain in their existing user directories.

Previously shipped 0.4.x and 0.5.x clients require one complete NSIS migration before using the new protocol. An already unstartable client needs the same complete installer once. That initial migration retains limitations of the old embedded NSIS uninstaller; it does not have the new protocol's interruption guarantees.

This change targets Windows x64. macOS and Linux retain their existing protocols. Persistent data schema is currently `1`; incompatible data schemas are rejected before installation. Code rollback is not data rollback.

## Reproduced legacy problems

`node wework/scripts/verify-windows-legacy-migration.mjs` runs actual historical updater source for 0.4.1, 0.5.10, and 0.5.12 against real HTTP and archives. Historical directory digests used both Windows-native and POSIX paths, producing different hashes for identical directory contents. Ordinary file digests agree across those implementations, which is why migration descriptors use file tickets.

Early 0.4.x clients lacked component preparation before startup, so thin packages cannot recover a missing executor. Removing legacy managed-component caches can also leave thin installations unable to start offline. Complete bundled startup and cache recovery have regression coverage. These reproducible protocol defects do not establish the cause of every reported upgrade failure.

## Protocol

The installation root `WeWork.exe` is an independent Rust launcher. Complete Electron versions live under `versions/<version>-<manifest-hash>/WeWork.exe`. Each `release.json` inventories file sizes and SHA-256 hashes using slash-separated relative paths. `windows-<channel>-v2.json` identifies the complete ZIP, size, and SHA-512. Signing precedes inventory generation.

Electron uses the system network stack, validates the download and extracted files, then validates again before shutdown. Native code waits for the parent, holds an OS file lock, revalidates, and publishes an immutable version directory. During upgrades, active state always names a confirmed version. Trial process trees use a process group or Windows Job Object. Electron writes a capability-protected acknowledgment only after runtime and renderer readiness. A failed candidate tree must stop before the previous version reopens. Launcher replacement is scheduled only after a healthy commit; ordinary startup retries explicit pending replacement requests without implicitly downgrading the launcher.

Complete NSIS packages contain `initial-update-state.json`, never live `update-state.json`. First installation verifies bundled resources before initialization. Overwrite installation invokes `--adopt-install`, verifies the complete new release and existing state format, paths, and data schema, then schedules a candidate. Missing or damaged old files do not prevent repair with a complete installer. If the new candidate also fails, unavailable rollback is reported explicitly. Interrupted extraction or damaged seed metadata cannot overwrite live state. Reinstalling the same version preserves existing state and version directories.

Shutdown handoff starts the native updater before stopping local services. Failure to spawn leaves the current application running. A failure during shutdown revokes the request and confirms updater exit before restarting the current version. After waiting for its parent, native code rereads the request; a revoked or changed request cannot install later.

Complete installations use their own bundled components and ignore legacy component activation state. Derived caches can be rebuilt offline. The old component protocol remains isolated to other platforms and old clients.

Legacy Windows feeds freeze a paired complete NSIS installer and migration component descriptor. Seven ordinary file tickets avoid the historical native/POSIX directory-hash incompatibility. Tickets are never activated as runtime code by the new version. The v2 feed rolls independently of frozen legacy feed versions.

PR #4101 is integrated: actual startup stages, current scan/extraction activity, slow-start reminders, and failure diagnostics. Main-process logs persist; failure recovery can copy redacted diagnostics and open the log directory. Logging failures must not block recovery. Update health depends on actual runtime and renderer readiness, independently of progress-bar percentages.

## QA plan

Every checkpoint creates its own installation, project, task, and model response. Only model services may be mocked. HTTP, filesystem operations, Electron, native processes, and installers remain real.

| Case                     | Action                                                                                                                                                          | Expected evidence                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upgrade                  | Start A, create a task/response, download B in-app and restart                                                                                                  | No NSIS; actual Electron version B; previous directory retained; task and response preserved; state, health acknowledgment, and launcher journal agree       |
| Corruption and retry     | Serve damaged ZIP bytes, then a correctly hashed ZIP missing `app.asar`, then a complete package                                                                | First two attempts fail without changing active; retry succeeds; concurrent requests transfer only once                                                      |
| Startup failure          | A real candidate Electron main process exits before acknowledgment                                                                                              | Candidate tree stops; A reopens; failed version never becomes active; task survives                                                                          |
| Cache recovery           | Upgrade, remove runtime caches, restart with cloud offline                                                                                                      | Bundled resources rebuild offline; B and task history remain usable                                                                                          |
| Transactions             | Native tests use real files/processes for parent waiting, concurrent locks, interrupted trials, corrupt/missing/linked/escaping files, and data-schema mismatch | No failed validation changes active; switching is serialized; interruption preserves a confirmed version                                                     |
| Launcher replacement     | Replace from a committed native copy; repeat with a damaged source                                                                                              | One atomic replacement; failure leaves a usable root launcher; healthy application state remains committed                                                   |
| Historical migration     | Install actual published 0.4.x, 0.5.x, and previous-version packages                                                                                            | Use the real old updater to migrate once, then upgrade using v2; rewritten version labels are not historical evidence                                        |
| Direct reinstall         | Create a task with an actual old installer, overwrite using full NSIS twice, then update in-app                                                                 | Task and response preserved; inactive complete versions survive; repeated installation preserves live state; subsequent v2 update succeeds                   |
| Interrupted installation | Retain old live state with a new seed and partially extracted version; run adoption and ordinary startup                                                        | Adoption rejects missing/corrupt files; live state remains unchanged; ordinary startup ignores the incomplete seed and starts old active                     |
| Damaged install repair   | Remove the old complete release or damage its `app.asar`, then adopt a complete new installer                                                                   | The verified new version can start; state and user data survive; unavailable rollback is logged explicitly                                                   |
| Handoff failure          | Use a missing updater, an updater that exits during shutdown, failing shutdown, and a revoked request whose parent exits                                        | Spawn failure does not stop services; shutdown failure confirms cancellation before recovery; revoked requests never activate later                          |
| Progress and diagnostics | Real Electron renders progress, slow startup, and failure; click diagnostic copying and read actual workbench startup logs                                      | Ordered stages reach renderer and splash close; soft timeout does not report failure; hard failure offers diagnostics; unwritable logs do not block recovery |

New-protocol fixtures use two real Electron package versions built from the same source. Historical compatibility requires actual published artifacts and a trusted signed migration installer. Do not disable installer signature verification to pass a test.

Prepare Windows packages and fixtures as CI does, then use the shared runner with `--segment windows-update-install`, `windows-update-validation`, `windows-update-rollback`, `windows-update-recovery`, `windows-update-migration`, or `windows-update-reinstall`. `wework-release-e2e.yml` with `suite=windows-update` runs the first four and actual signed 0.5.10 → two direct NSIS overwrites → v2. That direct-install check builds an unsigned new NSIS without disabling production updater signature validation. The formal release job runs migration and reinstall for actual 0.4.0, 0.5.10, and the dynamically selected previous release using its signed NSIS. If the previous release already uses v2, migration exercises that actual protocol. Native tests run with `cargo test --locked --manifest-path executor/Cargo.toml --test wework_launcher`. Windows locking and Job Object claims require Windows execution; macOS tests and an isolated Electron smoke test are complementary.

Retain normal checkpoint evidence, Electron logs, launcher JSONL, state, and assertion results. Stop isolated processes before deleting test directories. Personal Wework instances, native agent Homes, user projects, and project-space records are outside cleanup scope.

## Release constraints

Publish immutable complete artifacts before the v2 feed. Publish the legacy Windows NSIS/component pair together and freeze it after the first successful migration release. Never point v2 at a thin `WeWorkHostUpdate` package. Every code release must advance the application version; historical runtime-only tags cannot generate Windows feeds.

The current user must be able to write the installation root. Validated download ZIPs are removed after staging. Installed versions retain the previous working release. Older version directories are not automatically deleted because other sessions may still use them; safe collection needs a separate ownership protocol. Insufficient disk space fails the update while retaining active.

The macOS development host can run native transaction tests, real HTTP download tests, release-script tests, and isolated Electron smoke checks. Record Windows E2E and signed historical migration results from their actual CI runs; configuration alone is not a passing result.

## Verification record (2026-10-27)

- Electron: 150 files and 1,244 tests passed. Four separately selected macOS icon packaging checks passed. Three native icon checks remain unavailable because this host lacks Xcode `actool`.
- Native launcher: 34 real filesystem/process tests passed; four subprocess fixtures are explicitly invoked by those tests. Existing Executor library coverage passed 2,310 tests. Full Clippy and Rust formatting checks passed.
- Release/build: 24 files and 160 tests passed. Main-process type checking, changed-file lint/format checks, workflow YAML, and Bash syntax checks passed.
- Broad renderer tests exposed two assertions tied to the removed inline publisher. Both now exercise the actual publisher planner; the complete affected file passed all 10 tests after correction.
- An isolated real Electron workbench completed actual startup stages, runtime/renderer readiness, splash closure, and About version verification. Real Electron checks also covered progress, slow startup, failure recovery UI, and diagnostic copying.
- Windows execution, real NSIS reinstalls, and signed historical migration remain unexecuted. After the initial local pre-push rejection, the user authorized one exception and the branch was pushed as `fix/wework-transactional-updates`. GitHub's Actions page reports that this fork is paused due to usage scale. Repository and workflow enable operations succeeded, but dispatch still returned HTTP 422 without creating a run. A maintainer must continue from the signed-in page; configured CI is not a passing result.
