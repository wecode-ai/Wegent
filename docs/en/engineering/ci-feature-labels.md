---
sidebar_position: 35
---

# PR feature CI labels

Lint, type checks, unit tests and native plugin SDK checks retain their path-based ownership.
Feature labels select heavy E2E coverage inside the existing shared builds and runner pools.
The existing `Platform E2E Summary` and `Wework E2E Summary` validate both label coverage and job results.

## Labels

| Label              | Feature                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `ci:chat`          | Input, messages, streaming, voice and human interaction                              |
| `ci:agents`        | Agents, Bots, Models, Shells, Skills and capability catalogs                         |
| `ci:collaboration` | Projects, Issues, boards, dispatch, members, comments and deliveries                 |
| `ci:workspace`     | Workspaces, files, attachments, previews, artifacts, Git and worktrees               |
| `ci:runtime`       | Execution, queues, terminals, cancellation, recovery, Goals and history              |
| `ci:devices`       | Registration, identity, connectivity and remote-device lifecycle                     |
| `ci:plugins`       | Marketplace, installation, removal, updates, connectors, authorization, MCP and SDKs |
| `ci:knowledge`     | Import, document protocols, conversion, indexing and retrieval                       |
| `ci:automation`    | Scheduled execution, subscriptions, callbacks, notification directives and AI Cards  |
| `ci:stand-in`      | Personal stand-ins, source connections, confirmations and project coordination       |
| `ci:browser`       | Embedded browser, annotation, Computer Use and Harness Apps                          |
| `ci:desktop`       | Windows, startup, tray, menus, proxy and host state                                  |
| `ci:auth`          | Login, identity, shared access, permissions and security isolation                   |
| `ci:release`       | Full functional regression for update/release changes                                |
| `ci:all`           | All registered functional coverage and the existing platform/special gates           |

Feature unions deduplicate checkpoints within a profile; identical names in local and Cloud modes
remain separate coverage. Required labels preserve the original classifier's affected client surfaces:
desktop-only changes do not add Web service stacks, and Web-only changes do not add desktop runners.
Existing narrow desktop selections remain mandatory; broad selections are reduced to feature bundles.
Extra feature or platform labels explicitly widen coverage. Assertions inside scenarios are not pruned.

`ci:windows` adds the selected features' registered Windows Core cases. It does not claim Windows
parity for Cloud/Plugins. Requesting it for a feature with no Windows Core coverage fails the plan.
`ci:macos` adds the existing Inspector suite, not arbitrary macOS feature parity. Previously required
path-based Inspector coverage remains. The `ci:memory` name is retained without changing its execution policy.

## PR behavior

1. Basic checks run automatically. Actions summaries show required labels, selected features and the plan hash.
2. Add the suggested labels, or expand coverage with additional labels. `ci:all` covers every feature requirement.
3. Missing or unknown `ci:*` labels and unsupported platform requests fail both E2E summaries before expensive jobs start.
4. Adding/removing a CI label replaces the old plan. New commits recompute requirements.
5. Each summary reads current PR metadata again before succeeding. A different head, target branch or CI-label set invalidates the old plan.

Unrelated labels neither cancel code validation nor publish a new successful check under the canonical
E2E summary names. Existing basic-check workflows retain their label-event behavior.

Documentation alone needs no feature label, except the collaboration permission contract.
Unknown code, lockfiles, common CI infrastructure and selector changes conservatively require explicit
`ci:all`. The initial policy also treats test registration files conservatively; narrow those requirements
only after precise dependency evidence and contract coverage are available.

The recorded base SHA explains the analyzed diff. Advancing main alone does not invalidate tests on the
same head; branch protection and merge queue checks establish integration with main. Merge groups retain
full platform coverage and their existing desktop product-diff selection, excluding Windows/macOS special gates.

## Catalog and execution

`.github/ci/features.json` registers every frontend spec, its Playwright project, and Core/Cloud/Plugins
checkpoint ownership. `.github/scripts/ci-feature-policy.mjs` defines minimum path requirements and the
independent integration commands embedded in workflows.

New specs and checkpoints must have catalog entries. Missing files, unknown projects, unowned cases and
duplicate spec ownership fail planning. Desktop filtering uses the original classifier's matrices.
Platform bundles distribute specs within the existing four-shard limit; provider tests keep one worker.
A provider-only shard runs the existing setup first, preserving the provider command's `--no-deps` contract.

Storage, replication, MySQL concurrency, knowledge, DingTalk document protocol, subscription and notification
checks retain explicit feature ownership and their existing physical shards. Initial feature jobs still reuse
their complete existing service setup. No per-feature service stacks are added. Scheduled, dispatched and
`ci:all` runs retain the complete original matrices and Playwright sharding arguments.

`ci:release` does not publish packages or certify upgrade compatibility. Exact source/target package upgrade,
rollback, migration and hash evidence remain owned by the existing release maintenance contract and verifier,
which this change does not modify. The existing memory benchmark still runs only for `ci:all` PRs.

## Activation and verification

After merge, `CI Feature Labels` creates/updates registered labels without deleting other labels. It also
supports manual dispatch on main and has label-write permission only in that trusted context. Fork E2E needs
only read access to PR metadata and no new external service.
Maintainers add feature labels for external contributors without label-write access. Existing PRs should
update from main after rollout so their tested heads contain the planner, workflows and catalog together.

Branch protection should require the existing `Platform E2E Summary` and `Wework E2E Summary` checks.
Validate the selector PR itself with the existing `ci:all` label; new label synchronization runs after merge.

Focused local checks:

```bash
node --test .github/scripts/ci-feature-plan.test.mjs
bash .github/scripts/test-classify-ci-changes.sh
```

These validate planning, coverage and workflow contracts without running product E2E. CI continues to run
the selected real integration tests, with no added retries or weakened business assertions.
