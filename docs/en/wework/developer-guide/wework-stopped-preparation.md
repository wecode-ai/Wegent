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
