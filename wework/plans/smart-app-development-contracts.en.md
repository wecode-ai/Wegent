---
sidebar_position: 13
---

# Generic Smart App Development Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add capability-aware, machine-executable development contracts for every Wework Smart App and stop cross-boundary failures before installation by checking source, built artifacts, an isolated runtime, and the final ZIP.

**Architecture:** A single verifier in the Electron Host reuses Wework's pinned Node.js and DSH Runtime. The Smart App Builder reaches it through the existing token-protected local control bridge, while the renderer only presents typed results. `smart-app.verify.json` selects the minimum Host, Client, Remote, and runtime gates, and deterministic fingerprints bind a passing result to preview, packaging, and pre-publication actions.

**Tech Stack:** Electron, TypeScript, React, Vitest, DSH Workbench Runtime, Node.js `child_process`, Corepack/pnpm, FastAPI/Python for independent publication checks, and the desktop E2E runner.

---

The canonical, checkbox-level execution plan is the Chinese document at `plans/smart-app-development-contracts.md`. This file is the synchronized English scope and handoff summary; the Chinese plan wins if the two differ.

## Invariants

- Platform validation contains no domain, page-name, data-format, service-name, or layout assumptions.
- Contract values name package scripts; they are never interpreted as shell commands.
- Cold starts use one-time `DSH_HOME` directories, random loopback ports, and Wework's managed runtime.
- Personal DSH/Codex homes, credentials, Host tokens, and executor tokens never enter the verification process.
- Editable linked projects require a current passing result before export or publication. Existing managed and marketplace packages keep their compatibility path.
- The development verifier handles trusted local source. Install and Backend flows continue to scan ZIP files as untrusted inputs.
- The contract and `test-results/` are excluded from the ZIP. ZIP re-verification uses the already parsed and fingerprinted source contract.

## Contract

```json
{
  "schemaVersion": 1,
  "scripts": {
    "typecheck": "typecheck",
    "test": "test",
    "build": "build",
    "runtimeProbe": "verify:runtime"
  },
  "capabilities": {
    "host": true,
    "client": true,
    "remote": true
  },
  "runtime": {
    "profile": "web",
    "path": "/",
    "readySelector": "[data-testid=\"smart-app-ready\"]"
  }
}
```

`typecheck`, `test`, and `build` are required. `runtimeProbe` is required only for Remote projects. Remote implies Host and Client. Runtime profile must match the manifest, the path must remain same-origin, and the selector is treated only as data for a platform-owned query.

## Work packages

1. Define the strict contract parser, typed report, and stable error taxonomy.
2. Extract package, manifest, path, size, symlink, and secret validation from `smart-app-manager.ts`.
3. Generate minimal `web`, `host`, `web-host`, and `web-host-remote` scaffolds.
4. Add deterministic verification-input and deliverable fingerprints.
5. Run declared project scripts with Wework-managed Node/pnpm and `shell: false`.
6. Validate actual Host exports, Client metadata, included files, and ModuleLoader factories.
7. Cold-start DSH in isolation, probe the declared route and selector, and run an optional Remote package script.
8. Orchestrate the gates and persist an atomic report under `test-results/smart-app/`.
9. Require a current result for linked-project export, then unpack and re-verify the ZIP before publishing it.
10. Expose `wework smart-app inspect|verify|pack` through the token-protected desktop bridge and make the bundled Builder use that single entry point.
11. Show running, passed, failed, and stale states in the existing development preview UI.
12. Reuse the verified local archive before publication while retaining independent Backend package scanning.
13. Extend generic positive and negative fixtures plus the CI-covered `harness-apps` desktop checkpoint.
14. Update Chinese and English docs, run full checks, and execute isolated real-Electron QA.

Every package follows red/green TDD and ends in the Conventional Commit listed in the canonical plan.

## Required final verification

```bash
pnpm --filter wework typecheck
pnpm --filter wework lint
pnpm --filter wework test
pnpm --filter wework e2e:desktop -- --segment harness-apps
cd ../backend && uv run pytest
pnpm --filter wework ai:verify start
```

The real-Electron session must exercise a structural failure, a runtime failure, repair, re-verification, preview, ZIP export, import, and launch. Always stop the returned session and retain its sanitized evidence.
