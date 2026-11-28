---
name: repair-wework
description: Report or diagnose and fix the Wework desktop app on the affected machine, across its renderer, Electron host, and local Executor. Start when the user explicitly selects or names this skill.
disable-model-invocation: true
---

# Repair Wework

Run on the affected Wework device. If the conversation executes elsewhere, use diagnostics supplied by the affected device and report which checks still need to run there. This skill runs inside an existing conversation and requires a working agent session.

## Explain and confirm the goal

In the user's language, explain before collecting diagnostics that the AI can help submit a Bug report or attempt a source fix. Say which local evidence it may inspect, that the repair path may download the Wegent source and build in an isolated worktree, and that it will preview the material for any external report or PR. Raw logs and conversation content stay local.

Confirm the user's choice before proceeding. When the request already clearly selects a mode, state the selected mode and proceed. Otherwise use the host's structured question tool when available, with these choices:

- **Report a Bug** — collect the relevant evidence and prepare a report for the Wegent project. No source checkout is needed.
- **Try to fix it** — reproduce the problem, obtain the Wegent source if needed, make and verify a patch, then open a PR if requested.

Wait for the mode selection before collecting diagnostics or fetching source. An explicit Skill mention alone selects neither mode nor an external write.

## Locate the fault

Discover `wework_diagnostics` first. It attaches to the running instance that owns this local Executor. Use `read_trace_logs` to enumerate and read relevant Electron, renderer startup, and Executor transport logs. To investigate a live slowdown, tell the user when to reproduce and call `record_renderer` for the affected time window. It collects console entries, exception stacks, a Chromium trace and CPU call stacks together. Use `record_main_cpu` or `sample_process_stacks` when the evidence points to the host or Executor. Export the corresponding JavaScript heap when investigating retention. For native memory growth, compare instance metrics before and after reproduction and use `inspect_native_memory` on supported devices. Keep heap and trace files local and share only redacted findings. Capture the actual problem before starting an isolated reproduction.

Identify the failing user action, approximate time, OS, installed version, and the active runtime. Reuse evidence already available in the conversation. Use the desktop diagnostics bundle if provided, or read the relevant local logs around the failure. The Electron host resolves the log directory via `app.getPath('logs')`; inspect the directory for the affected instance only. Match timestamps and available request or run IDs across layers. Keep credentials, conversation bodies, and unrelated paths out of diagnostic excerpts.

| Layer         | Evidence and source                                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer      | Use the visible error and stack, `renderer-startup.log`, or Chromium DevTools Performance/Memory data for issues such as a blocked interaction or a stalled render. Source lives in `wework/src` and shared UI packages. Match source maps to the recorded build.                                           |
| Electron main | Inspect `wework-main.log`, `runtime-launch.log`, and `electron-host-transport.log` for startup and host IPC. Use process samples when the host stalls. Trace the relevant handler under `wework/electron/src`.                                                                                              |
| Executor      | Inspect `executor-transport.log` and the local runtime or Executor log. Distinguish a request that never arrived from one that started, failed, or finished without delivering its result. Trace the request in `executor/src`. Check `dsh-core-runtime.log` when the Core runtime or bridge is implicated. |

For performance issues, correlate `performance.log` or Process Explorer samples with the observed slowdown, then profile the implicated process where possible. Use the repository's Wework troubleshooting and performance diagnostics guides for product-specific collection steps. Capture the symptom before any reload or restart; preserve running tasks and ask before actions that would interrupt them or change personal application state. In repair mode, if the available evidence is inconclusive, use focused instrumentation in an isolated instance.

## Report a Bug

Prepare a concise issue with the expected and actual behavior, affected version and OS, reproducible steps, and the minimum redacted evidence. Search the official Wegent issue tracker for duplicates before opening an issue. Show the user the issue body and destination before submitting it with their authorization, following the bundled [GitHub skill](../github/SKILL.md). Return the issue link or the prepared report and exact submission blocker.

## Fetch the source and fix

- Use an existing checkout only after confirming it points to the intended Wegent repository. If no checkout exists, choose a new writable directory on the affected device and run `git clone --no-checkout https://github.com/wecode-ai/Wegent.git <checkout>`. Tell the user where the source was downloaded. If Git is missing or cloning fails, report the specific blocker and keep the diagnostic findings.
- Prefer the installed package's recorded `sourceSha` to reproduce the fault. Fetch the official refs if the revision is missing locally, then create an isolated worktree with `git -C <checkout> worktree add --detach <worktree> <sourceSha>`. If the matching revision is unavailable, record the revision actually tested and which conclusions remain unverified.
- Work in a separate worktree and follow the repository and affected module instructions. Reproduce the failing action with isolated development data. Fix the owning layer or the broken boundary and keep the patch focused. Use synthetic or explicitly supplied fixtures when the failure depends on local data.
- Re-run the original failure condition and relevant focused checks. For performance fixes, compare equivalent recordings before and after. Report what was verified on the affected device and what remains unverified. Keep the installed build and live data out of the source repair workflow.

## Hand off

When the user authorizes a PR, follow the bundled [GitHub skill](../github/SKILL.md) and the repository's contribution workflow. Verify the intended repo and base and show the user the proposed PR content and destination before publishing. Commit only the fix and supporting changes, then open the PR using the user's existing GitHub authorization. Include the affected build, reproducible steps, redacted root-cause evidence, and validation results. Keep raw diagnostics local. Return the PR URL or the specific blocker with the local branch and validation results.
