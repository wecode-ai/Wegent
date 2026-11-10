---
sidebar_position: 18
---

# Stopped preparation and bridge releases

Live environment prewarming must not rewrite session data. After the old runtime stops,
the snapshot completes and the existing `ReleaseActivation` is recorded, the bridge bootstrap
runs the target's stopped preparation before starting the independent health supervisor.
Migration time is outside the old launcher's 60-second activation budget. Only actual runtime
and renderer readiness can confirm health.

The target declares `weworkAfterStopPreparation: 1` in its own `package.json` and delivers
`dist/runtime/release-after-stop-cli.js`. The bridge invokes that entry with the target's
Electron, binding the activation token, target ID, package hash and source Workbench Homes.
Account and task credentials are not forwarded. Only a complete successful response publishes
`after-stop-ready.json`. The target bootstrap checks this receipt before opening data,
starting the executor or recovering Goals. Another activation or package cannot reuse it.

Reuse the existing activation journal, not a second recovery transaction. If preparation is
interrupted before the target trial starts, the next launch repeats the target's idempotent
entry. Preparation failure uses existing rollback: compatible data selects the healthy version
without restoring stale history; incompatible opened data still requires the existing restore
consent before preserving newer data and restoring the snapshot.

The bridge adds updater capability only, retaining its old Codex and session format. The later
target declares and performs data migration. A minimum source version is not compatibility
proof: verify both legacy-to-bridge and bridge-to-target upgrade/rollback against delivered
package hashes, source revisions and CI evidence. Native API-key/account ownership, history,
Goals and user repositories remain unchanged. Diagnostic builds and verification neither
publish a release nor automatically promote upgrade edges.

The target's offline entry waits for existing execution leases and native writers before
migrating, without starting model processes or recovering Goals. Waiting for a thread-file
lock must release coordination: native writer teardown also acquires coordination first.
After acquiring the file lock, recheck current inodes to handle unlinked lock files.
Ordinary model requests remain concurrent; this wait is restricted to stopped preparation.

Unpublished bridge and target packages can run complete diagnostics using two independent,
immutable build artifacts. Select the source build and all upgrade checks with publication
disabled. macOS runs the complete upgrade/rollback group and Windows runs the core round
trip. Diagnostics cannot produce promotable release edges.
Locally, `WEWORK_E2E_UPGRADE_WRITER_WAIT_SECONDS=65` holds a real native Codex writer beyond
the old launcher's 60-second budget. The default is 0; only integers from 0 to 600 are valid.
History must remain unchanged, the trial timer must remain unstarted, and no completion
receipt may appear while held. Releasing the writer must automatically resume preparation.
Local macOS runs should set an isolated `CFFIXED_USER_HOME`. Fixture paths follow the same
native Home as Foundation, avoiding the everyday application's singleton and legacy data.

Suite 20 adds real tool history, active Goals, native forks, compaction, and archived compressed
history for targets declaring stopped preparation. Tools must successfully write workspace
artifacts, and later inference must retain call identity. After upgrade and rollback, observe
automatic Goal inference before reading its state, retaining identity and nonzero accounting.
A paused Goal reactivated after its local execution finishes must regain recovery ownership
using the task's saved execution profile. Persist that ownership before acknowledging activation,
without resubmitting the old user input.
Ordinary startup must keep paused Goals paused. Reactivating an unloaded native thread must
start recovery through existing admission. Concurrent activations admit only one resume,
and a failed write must retain the previous recovery intent.
Create forks through Codex's own fork, compaction, archive, and cold-compression operations.
History bodies must remain byte-identical across transitions, with the same fork ID and ancestry,
and must support additional native turns.
