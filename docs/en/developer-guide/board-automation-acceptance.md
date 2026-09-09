---
sidebar_position: 10
---

# Board automation interaction and acceptance

The acceptance scope covers Issue creation, reusable experience configuration, sequential and AI assignment, human results, recovery, migration, and activity conversations. The [Chinese acceptance contract](../../zh/developer-guide/board-automation-acceptance.md) records the detailed requirement matrix and current evidence gaps.

Final delivery requires a test report, a step-by-step interaction report with actual screenshots, an architecture diagram, and sequence diagrams. A passing focused test does not prove an entire user flow. Every requirement must link to current execution evidence, including relevant error and recovery paths.

## Required journeys

1. Discover automation, create an experience, and understand permissions, unavailable services, saving, and draft recovery.
2. Configure sequential roles and AI coordination as peer modes; edit, reorder, delete, and reload role definitions.
3. Create an Issue with a clear goal and start it immediately or when processing begins.
4. Run sequential AI and human roles on the same Issue.
5. Let AI skip roles, return work for revision, assign a person inside or outside the graph, or execute outside the graph.
6. Submit human results with ownership checks and isolated drafts when switching Issues or assignments.
7. Pause, preserve in-flight results, resume, inspect failures, and retry without duplicate work.
8. Complete against the goal and continue independent tasks without reopening automation.
9. Start a new task from a new activity and continue the original session through replies, including queued and completed runs.
10. Explicitly adopt a reviewed experience on historical Issues while retaining history.
11. Verify scheduled and event triggers, disabled rules, filtering, execution history, and recovery.
12. Verify light/dark themes, both languages, narrow windows, long content, empty states, and canvas navigation.
13. Verify data migration, rollback protection, durable recovery, and stale/concurrent results using existing tables.

## Evidence rules

Reports must identify the command, code state, environment, timestamp, exit status, and evidence directory. Every interaction screenshot must identify its action and expected visible result. Diagrams distinguish Issue storage, execution devices, code workspaces, and task sessions. The Chinese contract includes the current architecture and assignment/conversation sequence diagrams.

The current verification covers 486 desktop unit tests, 340 backend tests, focused follow-up tests, both real desktop checkpoints, and a separate isolated Electron session. The local delivery directory `wework/test-results/experience-assignment/delivery/` contains the test report, 33 interaction screenshots, architecture and sequence diagrams, and logs.

Evidence limits remain explicit in the Chinese matrix: actual screenshot journeys now cover off-graph AI execution and coordinator retry; every execution-failure combination has not been visually checked, no 200% text-zoom acceptance, and no production MySQL migration. New core copy switches languages; pre-existing panels still contain Chinese text. Passing automated tests must not be reported as manual verification of every environment or UI combination.

## Event-center QA plan (2026-09-09)

Use isolated Electron, real FastAPI/SQLite/Redis and independent Runtime processes. Deterministic model responses invoke real MCP tools. Run CI-connected desktop coverage plus a separate `scripts/ai-verify.mjs` Electron session.

| Case | Preconditions and steps | Expected result | Coverage |
| --- | --- | --- | --- |
| E01 | Submit to an unconfigured board | Event retained; no premature Issue | API, isolated Electron |
| E02 | Submit unclear task, then answer | Clarification preserved; routing resumes | CI Runtime, isolated Electron |
| E03 | Route clear task with no matching experience | Issue-only graph executes; automation catalog stays empty | DB, CI Runtime |
| E04 | Register artifact on completed Issue, receive feedback | Same Issue and goal retained | DB, CI Runtime |
| E05 | Duplicate delivery and forged/stale decision | Deduplicated intake and rejected unauthorized decisions | API, Rust MCP, CI |
| E06 | Runtime rejection or failed reply, then recover | Input retained; retries preserve identities | Service, UI unit tests |
| E07 | Read as Reporter and use narrow window | Reads allowed, writes disabled, controls reachable | UI unit, isolated Electron |
| E08 | Read catalog after generated workflow; edit dispatch experience | No temporary template; dispatch trigger preserved | Service, editor tests |

Cleanup stops owned Electron, executors, backend and Redis processes. Fixtures remain only in isolated evidence databases.

### Event-center verification results

Verified on 2026-09-09 against the uncommitted workspace, without production deployment:

- `pnpm --filter wework e2e:desktop --segment event-center` exited 0 after 3m 57s. The packaged Electron/Executor used real backend requests and MCP calls to verify clarification, Issue-private workflow execution, artifact registration by the role, feedback to the completed Issue, and delivery deduplication. The automation catalog remained empty. Evidence: `wework/test-results/desktop-e2e/2026-09-09T03-36-59-769Z-51037/`.
- A separate `scripts/ai-verify.mjs` Electron run passed the primary flow and captured screenshots 01–03 in `wework/test-results/desktop-e2e/2026-09-09T03-23-38-997Z-97826/`. Its later extra board-navigation fixture failed, so the entire helper is not recorded as exit 0. The formal regression now refreshes the sidebar and clicks the new board.
- Another independent Electron run exited 0 and verified unconfigured intake, Reporter read-only access, a 1024×768 window, and English copy. Screenshots 04–07: `wework/test-results/desktop-e2e/2026-09-09T03-36-58-244Z-50570/`.
- Service/API, UI, and Rust MCP tests cover retained failures, retry identity, stale execution rejection, permissions, and template isolation. Every failure UI combination was not manually inspected. Deterministic model responses validate the real tool chain and state transitions, not arbitrary model decision quality.

The existing CI `project-automation` entry expands into `project-automation-workflow` and `event-center`, each with independent minimal fixtures. The event-center checkpoint also runs alone. The runner and CI coverage validation share the composite checkpoint definitions.
