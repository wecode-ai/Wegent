---
sidebar_position: 28
---

# dots-inspired Wework closed-loop user stories

## Purpose and sources

Verify three useful business loops in isolated real Wework Electron: customer feedback becomes a tested fix, changed scope becomes consistent launch materials, and new evidence becomes revised analysis and an implemented decision. Each loop requires original evidence, execution, inspection, feedback and reviewable outputs. An assistant saying “done” is insufficient.

Sources read on November 7, 2026: [OpenAI's announcement](https://openai.com/index/introducing-dots/) explicitly describes feedback fixes, launch revisions and updated analysis; [the official getting-started guide](https://learn.chatgpt.com/docs/dots/getting-started) explains context, feedback and human decisions; [MacRumors](https://www.macrumors.com/2026/09/29/openai-launches-dots/) discusses ongoing work and permissions; [9to5Google](https://9to5google.com/2026/09/29/openai-dots-agent/) covers investigation and reviewed action. The businesses, fixtures and checks below are Wework QA designs, not claims from those articles. They do not establish compatibility with every dots capability.

## Environment, boundaries and evidence

- Start an isolated desktop using `pnpm --filter wework ai:verify start`, an available model, a fixture-owned workspace and the primary personal assistant. Never operate a personal Wework window or inspect authentication contents.
- When the user explicitly chooses their local Codex account, use `WEWORK_E2E_NATIVE_CODEX_HOME="$HOME/.codex" pnpm --filter wework ai:verify start` to enable the existing native account mechanism while keeping session data isolated. Account inheritance is disabled by default, so an initially empty model catalog alone is not a product defect. Never read, print or commit authentication contents; run `ai:verify stop` afterward to remove the session link.
- Exploratory QA uses a real model. Automated E2E may script model responses while preserving real executor, tools, files, computation, delegation, human input, persistence and artifact declaration.
- The primary accepts the goal, delegates and returns the useful outcome; a child performs the work. Inspect actual files or command output and open deliverables from the original conversation.
- Navigate away and back while work is running or waiting. Reload after completion and check the current outcome and decision survive. Record loading, focus, errors, duplicate receipts and navigation problems.
- Use only fixture-owned local repositories and files. Do not publish announcements, send messages or push a fixture repository remotely.
- Automated E2E creates a real linked worktree from its existing private Git baseline and selects its `stories/` subdirectory using `current_workspace` mode. Primary and child summaries must retain that exact path and `workspace` kind, rather than claiming a managed worktree from the Git ancestor. Native default cwd is checked without a Shell `workdir` override; after reload, one click on the original primary's actual delivery card must open the real file preview.
- Stop children and the isolated session, restore test settings and clean fixture data. Screenshots, logs, session files and investigation evidence remain uncommitted.

## Story 1: customer feedback to a verified software fix

**User story:** As a product engineer, I want my assistant to investigate feedback and delegate a focused fix so I can review working software with test evidence.

**Prerequisites and data:** Create a fresh `cart-fixture/` Git repository containing `cart.mjs`, `cart.test.mjs` and `feedback.md`. The faulty `totalCents(items)` ignores quantity. Two units at 1200 cents plus one at 500 produce 1700 instead of 2900. Use Node's built-in test runner without external installation.

**Steps and acceptance:**

1. Ask the primary to delegate reproduction, regression coverage, repair and local delivery, restricting changes to the fixture.
2. Open the child task. Verify the added quantity regression fails with the actual 1700/2900 mismatch before the production change and passes afterward.
3. Return to the primary, inspect real test results and changed paths, open the code or diff, and independently run `node --test cart.test.mjs`.
4. Request a refinement: zero quantity contributes zero. Continue the existing work, add meaningful coverage and preserve the previous fix.
5. Reload and verify the latest result and reviewable change remain available, with one business completion per revision.

**Failure and recovery:** The initial regression failure is required evidence. A runtime or model failure must remain visible and recover through product controls. Do not rerun unchanged failing checks for a lucky pass. Final evidence must cover empty input, normal quantity and zero quantity, with no changes outside the fixture.

## Story 2: changed launch scope to reviewed, consistent materials

**User story:** As a launch owner, I want the assistant to reconcile a scope change, ask for my decision and revise all materials so I can approve one consistent customer promise.

**Prerequisites and data:** `scope-v1.md` promises CSV export, automatic scheduling and general availability on November 20, 2026. `scope-v2.md` retains only CSV export, defers scheduling and limits the audience to beta users, but omits the date. Existing `announcement.md` and `launch-checklist.md` retain the old promises.

**Steps and acceptance:**

1. Ask the primary to delegate comparison and prepare a revision, preserving existing materials until the date is decided.
2. Verify a structured question offers “November 20 beta” and “November 27 beta” with consequences. Before answering, work must visibly wait without inventing a date.
3. Navigate away and back, then answer the fixture decision: “Keep November 20, beta users only.” This does not authorize external publication.
4. Verify the original work resumes and actually writes a consistent announcement, checklist and `scope-change-summary.md`: CSV export, beta, November 20, scheduling deferred.
5. Request an explicit sentence saying automatic scheduling is excluded from this beta. Inspect the revised contents and verify them after reload.

**Failure and recovery:** No answer or cancellation cannot select an arbitrary option. Missing sources must not be guessed. The real answer must resume the owning work without a duplicate child. Drafts must never be described as already sent or published.

## Story 3: new commercial evidence to analysis and implemented judgment

**User story:** As a sales operations lead, I want updated order evidence reflected in analysis and my chosen follow-up priority so the team does not act on stale numbers.

**Prerequisites and data:** CSV columns are `order_id,customer,amount_cents,status`. Version one contains O1/Aster/10000/paid, O2/Birch/20000/paid and O3/Aster/5000/pending. Preserve an immutable copy. Version two changes O2 to refunded and adds O4/Cedar/30000/pending.

**Steps and acceptance:**

1. Delegate reading the CSV and delivering a reproducible analysis script and report. Verify initial paid revenue is 30000 cents and pending revenue is 5000.
2. The fixture operator updates the actual CSV and requests a refresh in the original conversation. Confirm new source data is read rather than an old answer repeated.
3. Independently run the script: paid 10000, refunded 20000, pending 35000, total 65000 cents. Paid revenue falls 20000 cents, approximately 66.67% from baseline. Refunded revenue cannot remain in paid revenue.
4. Verify a structured question offers prioritizing Cedar's 30000 pending order or investigating Birch's 20000 refund, and waits for the answer.
5. Answer “Prioritize Cedar; prepare an internal checklist only.” Verify actual `followup-plan.md` contents identify O4, amount, priority and the review boundary. Open both final report and plan from the primary result.
6. Reload and confirm the current report and decision persist. An old completion receipt cannot replace the revised outcome.

**Failure and recovery:** A `not-a-number` amount must produce a visible validation failure, never zero or false success. Restore valid data, continue the original work and verify correct recalculation. Never imply a customer was contacted.

## Automation integration and result records

Reuse the shared runner, checkpoints, model protocol, delegation receipts and artifact preview under `wework/e2e/desktop/`. Preserve existing meeting, weekly, source-version and email stories; they do not substitute for the actual edits, computation and human-decision assertions here. Every added checkpoint needs minimal independent prerequisites and registration in existing GitHub CI, without a separate test service or duplicate build.

For each run record environment, input, task identities, observed steps, command exit codes, actual files, failure causes, repairs, independent review and revalidation. The merge handoff must distinguish real-model exploration, E2E with scripted model responses, and unverified external-service compatibility. This page specifies acceptance; execution evidence and PR checks establish results. No pass is predeclared.
