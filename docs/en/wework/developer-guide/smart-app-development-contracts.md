---
sidebar_position: 40
---

# Smart App development contracts and verification gates

## Background

A Smart app combines editable source, a DSH profile bundle, optional Host and Client modules, plugin dependencies, and a final release archive. The existing development flow can create a directory, validate the basic manifest, launch an isolated runtime, and export a ZIP. However, each stage validates a different artifact at a different depth: structural validation checks only required files, the blank preset guarantees only a legal directory, and the runtime smoke test checks only that an HTTP page is served.

As a result, some boundary failures surface only after installation or real interaction. Examples include code reading an undeclared service, a page registering on a surface that does not match product intent, a build artifact that the Client module loader cannot discover, or incompatible communication protocols on the Host and Client sides. These failures are business-independent. Their common cause is that project intent is not represented as a machine-executable development contract.

This document defines a capability-aware, general development contract. The platform defines how intent is declared and verified; each Smart app continues to decide which capabilities it provides and what state means that its business behavior is ready.

## Goals

- Detect service dependency, module discovery, composition, remote communication, and runtime environment failures during development and packaging.
- Support Host-only, Client-only, Host + Client, Remote, and multi-package compositions.
- Verify the final deliverable rather than only source files or the development directory.
- Use the DSH and Node.js runtimes managed by the current Wework build instead of implicitly selecting the latest network version.
- Run all runtime verification in a temporary, isolated `DSH_HOME` without reading or modifying existing user DSH credentials.
- Preserve application freedom by keeping page names, data types, service names, and UI layouts out of platform rules.
- Give the Smart App Builder stable, structured, actionable failures instead of ambiguous startup errors.

## Non-goals

- Do not introduce a Smart App runtime SDK that wraps DSH.
- Do not require every Smart app to use a model, Remote, or custom page.
- Do not make the platform understand or assert business-specific results.
- Do not replace Wework installation security checks, runtime isolation, or failure rollback with development verification.
- Do not require historical marketplace archives to contain development-only verification files.

## Considered approaches

### Strengthen only the Smart App Builder instructions

The Skill could document service injection, module loading, and isolated verification rules. This is the smallest change, but it cannot enforce the rules. Model changes, long conversations, and manual edits can bypass guidance, so this approach is insufficient on its own.

### Development contract plus a unified verifier

Each editable Smart app declares its capabilities, build commands, and minimum readiness condition. A unified tool executes static checks, builds, isolated cold starts, and deliverable re-verification according to that declaration. This blocks known failure classes without requiring the platform to understand business semantics.

This design selects this approach.

### Introduce a Smart App SDK

A new high-level API could wrap DSH service injection, Remote, module loading, and page registration. It would reduce direct API mistakes, but it would also create a second runtime abstraction and a long-term compatibility burden. DSH already exposes these standard capabilities, so this design does not introduce that layer.

## Architecture

```text
Project capabilities and acceptance intent
                 │
                 ▼
       smart-app.verify.json
                 │
                 ▼
        Unified verifier
  ├─ Structure and security validation
  ├─ Project contract tests
  ├─ Type checking and build
  ├─ Build artifact validation
  ├─ Isolated DSH cold start
  ├─ Client readiness/Remote probe
  └─ Post-extraction ZIP verification
                 │
                 ▼
 Fingerprinted verification result
                 │
                 ▼
     Preview, package, or deliver
```

The development contract describes intent, project tests prove business-related expectations, and the verifier supplies a consistent execution environment and mandatory gates. The Wework installer remains responsible for security, structure, and compatibility checks on untrusted packages; these responsibilities do not merge.

## Development contract

### Location and lifecycle

An editable Smart app declares its development contract in `smart-app.verify.json` at the project root. New presets must generate it. When an existing directory is linked, Smart App Builder inspects the project and adds or updates the contract according to its actual capabilities. Marketplace and read-only imported packages may omit the file, but a directory without a contract cannot receive a “development verified” state.

The file is excluded from release ZIPs. It contains no credentials, ports, machine-specific paths, or business data.

### Contract shape

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

Field rules:

- `schemaVersion` is an explicit version supported by the verifier.
- `scripts` references script names from the project `package.json`. The verifier invokes them through fixed Corepack/pnpm argv, so it neither guesses the build tool nor passes contract values to a shell.
- `capabilities` declares only the runtime boundaries the project actually uses.
- `runtime.profile` must match the entry profile in `plugin-manifest.json`.
- `path` and `readySelector` define an application-owned, minimally observable readiness condition without expressing business content.
- Concrete Remote methods, parameters, and business assertions remain in project contract tests instead of being duplicated in JSON.

## Capability-aware verification

The verifier selects checks from `capabilities`; it does not force one template onto every project:

| Capability                       | Mandatory checks                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Host                             | Entry can be imported, dependencies resolve, declared injection is satisfiable, and the process starts and stops                     |
| Client                           | Package metadata exposes the Client entry, the artifact follows the DSH ModuleLoader factory format, and the browser module executes |
| Remote                           | Project Remote contract tests pass and the isolated runtime completes at least one real round trip                                   |
| Custom page                      | The declared path is reachable and the project-defined readiness selector appears before timeout                                     |
| Multi-package or external plugin | Package names, paths, roles, versions, and bundle patches resolve in the final profile                                               |

Static checks provide fast feedback for deterministic errors. Service availability, actual module loading, and Remote reachability must be proven in the isolated runtime.

## Five verification gates

### 1. Structure and security

Extend existing manifest checks to validate:

- Manifest identity, version, runtime requirements, and entry.
- A single profile bundle that matches `entry.installPackage`.
- Packages, plugins, local paths, duplicate declarations, and path traversal.
- Package metadata, DSH bundle patches, and the development contract.
- Symbolic links, archive size, extracted size, and sensitive files.

Passing this gate does not claim that the Smart app can run.

### 2. Project contracts and build

Run the declared typecheck, test, and build scripts, stopping immediately on any failure. New scaffolds include boundary tests appropriate for their selected capabilities: Host startup, Client loading, composition intent, and an optional Remote round trip.

The project owns business assertions. The unified verifier only requires declared commands to exist, execute for real, and exit successfully.

### 3. Build artifacts

Validate actual artifacts rather than source text:

- Node entries resolve and import through declared package exports.
- Client entries register a module factory in a controlled ModuleLoader fixture.
- Exported `package.json` metadata is discoverable by DSH.
- `files`, exports, bundle patches, and actual artifacts agree.
- A source entry omitted from the published files cannot pass.

### 4. Isolated cold start

The verifier uses runtimes provided by the current Wework build in a disposable environment:

1. Create a temporary `DSH_HOME` and profile.
2. Write the minimum non-sensitive configuration supported by that runtime.
3. Install the final packages and plugins declared by the Smart app.
4. Run `--dump-config` and retain a redacted summary.
5. Start DSH with `--no-open` on a random loopback port.
6. Wait for Host health and the Client page.
7. Assert `path` and `readySelector`.
8. Run the project-provided runtime probe when Remote is declared.
9. Stop all processes and delete the temporary environment.

Failures retain isolated logs, but logs must not contain credentials, full user paths, or business input.

### 5. Deliverable re-verification

`pack` requires complete verification of the same content version:

1. Produce a deterministic “verification input fingerprint” covering source, dependency declarations, manifest, development contract, and bundle patches.
2. Complete the first four gates.
3. Generate the ZIP.
4. Extract it into a second temporary directory.
5. Re-run structure, artifact, and cold-start verification on extracted content.
6. Produce a separate “deliverable fingerprint” and ZIP hash; succeed only when verification inputs are unchanged, deliverable content matches the ZIP, and re-verification passes.

Any change to source, dependencies, manifest, development contract, or bundle patch invalidates the previous result.

## Scaffolding strategy

Smart app creation begins from the smallest capability template:

- `web`: Client entry, build configuration, readiness surface, and Client loading test.
- `host`: Host entry, explicit injection, and startup test.
- `web-host`: Host, Client, shared types, and independent tests for both sides.
- `web-host-remote`: The previous template plus Remote definitions, Host registration, and a round-trip test.

Templates contain only generic readiness state or health checks. They do not inject models, files, network access, or other optional services by default. Once requirements are known, Smart App Builder removes unused examples and capabilities so the contract matches the implementation.

## Smart App Builder workflow

Smart App Builder follows this state machine:

```text
inspect → contract → doctor → validate → test → build
        → verify-artifacts → cold-start → preview → pack-verify
```

- `inspect`: Read the existing manifest, packages, dependencies, source, and profile without replacing the directory.
- `contract`: Identify Host, Client, and Remote capabilities and create or update the development contract.
- `doctor`: Check the Node.js, pnpm, and DSH runtimes supplied by current Wework.
- `validate`: Run structure and security validation.
- `test/build`: Execute project-declared package scripts through fixed Corepack/pnpm argv.
- `verify-artifacts`: Validate actual build output.
- `cold-start`: Install and start in an isolated environment.
- `preview`: Use the Wework WebView to verify the primary path, one invalid-input path, and recovery.
- `pack-verify`: Package and re-verify from the ZIP when distribution is requested.

Any failed gate stops later stages. The builder reads the structured error and relevant logs before fixing the primary path. It does not add unapproved compatibility paths or silent fallbacks.

## Change classification and verification invalidation

| Change                            | Development action                         | Pre-delivery action                     |
| --------------------------------- | ------------------------------------------ | --------------------------------------- |
| Client implementation             | Page refresh or HMR                        | Full cold start and ZIP re-verification |
| Host implementation               | Restart DSH                                | Full cold start and ZIP re-verification |
| Remote contract                   | Restart both sides and run round-trip test | Full cold start and ZIP re-verification |
| Package, exports, or dependencies | Reinstall and restart DSH                  | Full cold start and ZIP re-verification |
| Manifest or bundle patch          | Prepare the profile again                  | Full cold start and ZIP re-verification |
| Documentation only                | Keep runtime result valid                  | Packaged-content security check         |

File fingerprints determine whether a verification result remains valid; human judgment and file-watcher events do not.

## Error model

Verification reports use stable stage codes:

- `SA-ENV-*`: Node.js, pnpm, DSH, or isolated environment.
- `SA-MANIFEST-*`: Manifest, package structure, or paths.
- `SA-DEPENDENCY-*`: Plugin or service dependencies.
- `SA-HOST-*`: Host import, startup, or exit.
- `SA-CLIENT-*`: Client entry, exports, or ModuleLoader.
- `SA-COMPOSITION-*`: The actual page does not reach the project-declared entry or readiness condition.
- `SA-REMOTE-*`: Remote registration, call, or response contract.
- `SA-RUNTIME-*`: Profile, dump-config, port, or process lifecycle.
- `SA-PACKAGE-*`: ZIP content, fingerprint, or cold installation.

Each issue contains `code`, `stage`, `file`, `message`, `expected`, `actual`, `blocking`, and a repair hint. Commands emit a human-readable summary by default and support JSON output for Smart App Builder and Wework UI consumers.

## Product integration boundaries

- The development verifier operates on trusted local source; the Wework installer retains the untrusted-package security boundary.
- “Development verified” does not mean “marketplace approved.” Marketplace review still checks permissions, sensitive files, platform compatibility, and publication policy.
- The preview toolbar can show the current stage, errors, and whether file changes invalidated verification, but it does not interpret business results.
- Installation rollback remains the last safety net and does not replace development cold starts.
- Existing installation archives require no migration. Smart App Builder creates a development contract only when they are copied or linked for editing.

## Test matrix

### Positive fixtures

- Host only.
- Client only.
- Host + Client.
- Host + Client + Remote.
- Multi-package profile bundle.
- Composition with local and remote DSH plugins.

### Negative fixtures

- Code depends on a service that is undeclared or absent from the profile.
- Client registration succeeds but does not satisfy the project-declared entry or readiness condition.
- Package exports omit metadata or entries required by the runtime.
- Source is correct but output lacks a ModuleLoader factory.
- Host and Client Remote methods or data contracts disagree.
- DSH or Node.js does not satisfy requirements.
- User DSH configuration is invalid, but isolated verification still succeeds.
- The development directory runs, but the ZIP is incomplete or fails cold installation.
- Content changes after verification and the stale result is rejected.

### Wework Electron E2E

- Create a Smart app from every minimal template.
- Open Smart App Builder and complete verification.
- Introduce one structural and one runtime error; confirm the preview shows an actionable failure and packaging is blocked.
- Repair, run the embedded preview, export, re-import, and start the ZIP.
- Confirm temporary runtimes, ports, and logs are cleaned on both failure and success paths.

## Delivery phases

### P0: Mandatory development gates

- Define the `smart-app.verify.json` schema.
- Expand the blank preset into capability templates.
- Add `inspect` and `verify` to the development tool.
- Implement project commands, artifact validation, and isolated cold starts.
- Make `pack` require a successful verification with a matching content fingerprint and re-verify the ZIP.
- Update the Smart App Builder Skill with the state machine and failure behavior.

### P1: Wework development experience

- Show stages, error codes, and stale verification state in the development preview.
- Recommend page refresh or DSH restart based on change classification.
- Save redacted records under `test-results/smart-app/`.
- Give each error a file location and repair entry point.

### P2: Publication and installation reuse

- Reuse ZIP structure, artifact, and cold-install checks before publication.
- Attach verification summaries as publication evidence without trusting self-reported results inside the package.
- Preserve installation rollback and runtime isolation as independent final defenses.

## Acceptance criteria

- All five cross-boundary failure classes fail during development with stable error codes.
- Verification rules contain no industry, page, or data-type assumptions.
- All six positive fixtures pass only their required minimal verification set.
- A Smart app that does not declare a capability is not required to implement it.
- `pack` rejects stale verification and detects failures that exist only in the ZIP.
- Verification never reads, overwrites, or migrates user DSH credentials.
- Wework embedded preview and real Electron E2E cover failure, repair, re-verification, and cleanup.
