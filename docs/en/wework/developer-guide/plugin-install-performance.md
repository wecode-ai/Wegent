---
sidebar_position: 29
---

# Targeted plugin synchronization and cache reuse

Installation, reinstallation, updates, enablement and component changes synchronize only the affected plugins. Uninstallation sends explicit removals. Manual refresh and device reconnection retain complete desired-state reconciliation. Account installation records describe desired state; device acknowledgements describe local materialization.

## Protocol and compatibility

Backend sends protocol v2 only when the Executor explicitly advertises `runtime_features.pluginSync.protocolVersion=2`. Missing, malformed or unsupported advertisements retain legacy behavior. Wework application version numbers do not determine support. Python and Rust device feature projections both preserve this capability.

The protocol reuses `device:sync_capabilities` and existing HTTP URLs and response fields:

```json
{
  "mode": "merge",
  "scope": "plugin_delta",
  "plugin_sync": { "version": 2, "generation": 7, "complete": false },
  "plugins": [],
  "removed_plugins": [
    { "installed_plugin_id": 123, "name": "example", "marketplace": "wegent" }
  ]
}
```

Plugin reconciliation uses `scope=plugins` and `complete=true`; reconnect synchronization can still replace all capabilities. The selected-capability API also orders plugin changes on new devices. Skills, MCP, authentication, logout and plugin invocation APIs retain their existing responsibilities.

Devices on the same account negotiate independently. Installation initiated from a new device waits for that device; other devices synchronize in the background. Persisted pending installations and removals, together with reconnect reconciliation, provide recovery. Legacy devices retain their previous full synchronization cost.

## Ordering and acknowledgements

- Backend stores account snapshot sequences and device watermarks in existing `Kind` resources. A short user-row lock serializes fresh snapshot reads. It commits and releases database connections before network calls.
- Sent intent watermarks fence obsolete acknowledgements. Recording checks generation and the dispatched version, checksum, enablement and component state against current desired state. Delta acknowledgements affect only requested plugins.
- Executor persists accepted intent, complete-snapshot watermarks, plugin generations and removal tombstones. Independent plugins may arrive out of order. Delayed snapshots cannot delete newer installations, failed operations remain retryable, and delayed installs cannot revive removed plugins.
- Identical requests with the same generation share in-flight results. Different generations recheck ordering and local health, including installation–removal–reinstallation sequences.
- Persistent ordering state is scoped to the active authentication binding. Previous handlers in the process cannot take control back after an account switch.

## Cache reuse and timing

A trusted SHA256 triggers local shared-package verification before download. Changed checksums, missing packages or damaged content require download and validation. Downloads without a trusted checksum remain necessary.

Healthy owned files, generated manifests, native configuration, enablement and component state skip runtime copying and configuration rewriting. Missing or damaged runtime files are repaired from a verified local package. Additional mutable native cache files do not invalidate owned files.

Damaged shared packages use package locking, validated staging, quarantine and rollback. Failed publication preserves the existing runtime. Missing or damaged ownership records, mismatched identities and occupied symlinks are rejected rather than overwritten; ownership-record damage still needs manual repair.

`plugin_sync_completed` logs queue and total time. Plugin phase logs include verification, download, package processing, local activation, bytes and cache hits. Backend records RPC time, plugin counts and generation.

## Verification and comparison

`executor/tests/plugin_install_performance.rs` uses a real temporary filesystem, 13 warmed plugins and three new installations. Only package transport is simulated with a 10ms delay. The same fixture runs against a temporary `upstream/main` source snapshot (`64def2c13`) with `WEGENT_PLUGIN_PERF_BASELINE=1` and against the new code in its default mode. Compilation is excluded.

Under these conditions main processes complete lists of 14, 15 and 16 plugins. The optimized path sends three single-plugin deltas. A single debug-build measurement on 2026-10-22 produced the following results; each of the 16 ZIP packages was 329 bytes:

| Metric                                |        main | Optimized |
| ------------------------------------- | ----------: | --------: |
| Downloads                             |          45 |         3 |
| Downloaded bytes                      |      14,805 |       987 |
| Cumulative download time              |   533.720ms |  36.847ms |
| Total time for three installations    | 1,432.304ms | 265.768ms |
| Existing runtime directories modified |          13 |         0 |

Downloads decreased by 93.3% and total time by 81.4% in this run. The fixture emits `PLUGIN_INSTALL_PERFORMANCE_RESULT` JSON. This controlled comparison does not replace remeasuring the reported 61.5/72.3/43.6-second API requests in the original environment. Run the optimized fixture from `executor/`:

```bash
cargo test --test plugin_install_performance -- --nocapture
```

Use the same command with `WEGENT_PLUGIN_PERF_BASELINE=1` in the baseline snapshot. Use separate `CARGO_TARGET_DIR` values for the two source trees to prevent stale artifacts from being reused for packages with the same name and older source timestamps.

Focused regression coverage includes negotiation, concurrent installations, interleaved removal, desired-state changes, out-of-order acknowledgements, account switching, recovery, cache corruption and runtime repair. The existing CI-covered desktop `plugin-upgrade` checkpoint now asserts targeted concurrent installations and an unchanged unrelated plugin record. E2E and `ai:verify` are run only when explicitly requested.
