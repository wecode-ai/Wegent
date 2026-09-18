---
sidebar_position: 31
---

# Wework device diagnostics

The read-only `deviceDiagnostics.microphone` capability is available to core DSH and independent
Smart Apps. Version 1 checks macOS microphone permission, lid state, hardware disconnect support,
Hardened Runtime audio entitlements on the app and audio Helper, and the microphone usage description.
Other platforms return `unsupported`. It does not request permission, record audio, change settings,
or read the TCC database.

## DSH integration

Plugins declaring a dependency on `weworkDesktop` use the same server and browser API:

```ts
const result = await ctx.weworkDesktop.deviceDiagnostics.microphone({
  inputDeviceKind: "built-in",
});
```

`inputDeviceKind` accepts `built-in`, `external`, or `unknown` (default). It describes the selected
device as confirmed by the caller; it does not switch devices. Omit it if uncertain: a device ID of
`default` does not establish that the input is built in. Types are exported from
`@wegent/dsh-electron-host/desktop-service`.

The same-origin Host HTTP endpoint is also available:

```http
POST /wework/electron-host/v1/invoke
Content-Type: application/json

{"capability":"deviceDiagnostics.microphone","params":{}}
```

A completed diagnosis returns HTTP 200 with `{ok: true, result}`, including when a blocker is found.
An invalid device kind returns HTTP 400 with `error.code: invalid_params`.
Use the service's `describe()` capability list to detect older hosts; an unavailable capability
means the host needs an update, not that the microphone is healthy.

## Response contract

`result` contains `schemaVersion: 1`, `platform`, ISO timestamp `checkedAt`, overall `status`, primary
`code`, all `issues`, caller-supplied device kind, and native evidence in `checks`.
Each issue has a `code`, `severity` (`error` / `warning` / `info`), and suggested `actions`.
Actions are identifiers only; Wework does not execute them automatically.

| status        | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `blocked`     | At least one confirmed blocker                                        |
| `warning`     | Permission is pending or a condition may affect the selected device   |
| `unknown`     | Essential evidence is unavailable and no higher-priority issue exists |
| `ok`          | No known host blocker was found; audio capture has not been verified  |
| `unsupported` | This diagnostic version does not support the current platform         |

The primary code selects errors before warnings, then informational issues, preserving issue order
within each severity. Signing configuration issues precede permission and lid issues. Consumers
should retain all issues rather than handling only the primary code.

| Code                                      | Suggested message / actions                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `MICROPHONE_PERMISSION_DENIED`            | Allow Wework microphone access in system settings; `open_microphone_settings`                          |
| `MICROPHONE_PERMISSION_RESTRICTED`        | System policy restricts microphone access; `contact_administrator`                                     |
| `MICROPHONE_PERMISSION_NOT_DETERMINED`    | Request access when the user starts recording; `request_microphone_access`                             |
| `MICROPHONE_APP_ENTITLEMENT_MISSING`      | The app lacks the audio signing entitlement; `update_application`                                      |
| `MICROPHONE_HELPER_ENTITLEMENT_MISSING`   | The audio Helper lacks the audio signing entitlement; `update_application`                             |
| `MICROPHONE_USAGE_DESCRIPTION_MISSING`    | The app lacks a microphone usage description; `update_application`                                     |
| `MICROPHONE_BUILT_IN_DISABLED_LID_CLOSED` | The closed lid disables the selected built-in microphone; `open_lid` / `select_external_microphone`    |
| `MICROPHONE_LID_CLOSED`                   | The lid is closed; if using the built-in microphone, open it or select an external input; same actions |
| `MICROPHONE_DIAGNOSTICS_INCOMPLETE`       | Some device checks are unavailable; `retry_diagnostics`                                                |
| `MICROPHONE_DIAGNOSTICS_UNSUPPORTED`      | Host diagnostics are not supported on this platform                                                    |
| `MICROPHONE_NO_KNOWN_BLOCKER`             | No known host blocker; continue checking the actual audio signal                                       |

## Boundaries and call timing

- Permission comes from Electron's system permission API. It does not prove browser-origin access.
  Developer tools launching the app can affect macOS responsible-process attribution; verify an
  independently launched package when testing permissions.
- Signing checks inspect metadata on the current app and its generic Helper, which hosts the audio
  service. Missing audio entitlement is a blocker only with confirmed Hardened Runtime enabled.
  This does not verify signature authenticity, notarization, or official publisher identity.
- This version confirms hardware disconnect support for Apple Silicon only; Intel/T2 support remains
  `null`. A closed lid is a blocker only with confirmed hardware support and caller-confirmed built-in
  input. External input receives no lid issue; unknown input receives a conditional warning.
- Failed, timed-out, or unparseable probes return `unknown` / `null`, never a false missing-entitlement
  claim. Each native command has a 2-second timeout. Every call refreshes evidence, allowing recovery
  after the user opens the lid.
- Call before recording, after permission failure, or after sustained silence, then offer retry after
  corrective action. Do not poll at audio-frame frequency. DSH still owns signal analysis, device
  selection, recording interruptions, and user messaging. Silence alone cannot identify a host
  permission defect.

Signing defects require Wework's official signing and packaging pipeline. DSH messaging cannot add
host entitlements.

## Regression verification

Unit tests cover severity priority, missing versus unknown evidence, input kinds, permissions,
failures, and recovery. DSH service tests cover browser/server mappings and disposal.
The existing CI `dsh-owner-capture` checkpoint exercises the real endpoint in core DSH and an
independent Smart App, invalid parameters, and recovery. The `release-package-startup` checkpoint
checks microphone signing entitlements on release packages.
