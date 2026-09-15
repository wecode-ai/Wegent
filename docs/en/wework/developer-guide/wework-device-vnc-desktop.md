---
sidebar_position: 41
---

# Wework Device VNC Remote Desktop Plan

## Status

This is the implementation plan for Wework / Wecode device remote desktop. The desktop capability is a generic VNC WebSocket feature: the viewer only receives an authorized VNC WebSocket URL. Cloud devices and remote devices share the same client, backend session API, and Executor session gateway path.

## Goals

1. Wework can open a real Linux desktop from a cloud device card.
2. The viewer does not know device types, tokens, RFB addresses, or container details; it only accepts `websocketUrl`.
3. Device capability is reported by live Runtime heartbeats, and the UI only shows the entry when the capability is currently usable.
4. The backend only creates VNC sessions for online devices that expose a valid live desktop capability.
5. VNC only listens on the container or host loopback interface. Public `5900/5901/6080` ports must not be exposed.
6. Screen, keyboard, mouse, and text clipboard behavior must have a local verification loop.

## Architecture

```mermaid
flowchart LR
  A[Wework UI] -->|deviceId| B[Backend POST /devices/{id}/vnc]
  B -->|device:start_vnc_session| C[Executor]
  C --> D[Session Gateway /s/{session}/websockify?token=...]
  D -->|raw TCP proxy| E[127.0.0.1:5901 TigerVNC]
  E --> F[XFCE Desktop]
```

The fixed client boundary is:

```ts
<VncViewer websocketUrl={session.url} />
```

`VncViewer` does not receive device metadata, tokens, protocol options, or capability flags. Authorization, address validation, and capability checks happen above it in the UI, backend, and Executor.

## Device capability model

Runtime heartbeat `runtime_features` uses schema v4:

```json
{
  "schemaVersion": 4,
  "shells": {
    "terminal": { "available": true },
    "codeServer": { "available": true }
  },
  "desktop": {
    "version": 1,
    "available": true,
    "protocol": "rfb",
    "transport": "websocket",
    "clipboard": "extended-text"
  }
}
```

The device VNC capability is expressed in three layers:

1. **Image/runtime configuration**: the device container installs TigerVNC, XFCE, and xclip, and sets `DEVICE_VNC_DESKTOP_ENABLED=true` plus `DEVICE_VNC_RFB_ADDR=127.0.0.1:5901`.
2. **Executor live probe**: before reporting heartbeat features, the Executor probes the loopback RFB banner. It reports `desktop.available=true` only when the probe succeeds.
3. **UI fail-closed gating**: Wework only shows the desktop entry when the device is cloud/remote, usable, and has a live `rfb + websocket` capability.

If the VNC process is down, the RFB address is not loopback, the session gateway is disabled, or the backend receives malformed live capability metadata, the entry is hidden and the session endpoint rejects creation.

## Runtime configuration

The device container enables VNC desktop by default:

| Variable                         | Default          | Meaning                                                                        |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `DEVICE_SESSION_GATEWAY_ENABLED` | `true`           | Required; VNC is exposed only through the token-gated gateway                  |
| `DEVICE_VNC_DESKTOP_ENABLED`     | `true`           | Starts and reports the VNC desktop                                             |
| `DEVICE_VNC_RFB_ADDR`            | `127.0.0.1:5901` | Internal RFB address used by the Executor; the managed image requires loopback |
| `DEVICE_VNC_CLIPBOARD_MODE`      | `extended-text`  | Clipboard capability reported to clients                                       |
| `DEVICE_VNC_GEOMETRY`            | `1440x900`       | TigerVNC virtual desktop size                                                  |

The image only exposes `17888` and `18080`. It does not expose `5901`. TigerVNC uses `SecurityTypes None` because it listens only on localhost; access control is enforced by the device session gateway token.

Remote-device demos use the same pattern: run a VNC server inside the device environment, keep RFB on loopback, and expose only the backend-issued VNC WebSocket session URL.

## Session flow

1. UI calls `POST /api/v1/devices/{device_id}/vnc`.
2. The backend reads live `runtime_features.desktop` and requires:
   - `available=true`
   - `protocol=rfb`
   - `transport=websocket`
   - online device state and user authorization
3. The backend sends a `device:start_vnc_session` RPC.
4. The Executor creates a `SessionType::Vnc` local session, validates that `DEVICE_VNC_RFB_ADDR` is loopback, and checks that the RFB TCP port is reachable.
5. The Executor returns `ws://.../s/{session_id}/websockify?token=...`.
6. The noVNC viewer connects to that WebSocket, and the gateway proxies WebSocket binary frames to `127.0.0.1:5901`.

## Client behavior

Cloud and remote devices share one DSH internal page: `/device-desktop?deviceId=...`. The route stores only `deviceId`; it never stores the session token in the tab URL.

The viewer provides:

- connection status;
- paste;
- Ctrl+Alt+Del;
- view-only/control toggle;
- fullscreen;
- disconnect.

In Electron, VNC clipboard access goes through main-process `vncClipboard.*` capabilities and requires the current Wework window to be focused with a matching lease. In browser contexts, the viewer falls back to the standard Clipboard API.

## Clipboard validation

VNC clipboard must be verified in both directions:

1. **Remote to local**: copy text inside the VNC desktop; noVNC emits a `clipboard` event; Wework writes the local clipboard.
2. **Local to remote**: copy text locally and click **Sync local clipboard** in the viewer; the viewer calls `clipboardPasteFrom(text)`. This updates the remote clipboard without assuming a remote operating system or application shortcut. After synchronization, paste in the remote application. Linux graphical terminals normally use `Ctrl+Shift+V` or `Shift+Insert`, while ordinary editors normally use `Ctrl+V`.

To copy from a Linux terminal to the local machine, select the text and use the terminal's own copy shortcut, normally `Ctrl+Shift+C`. macOS `Command+C` is not automatically the copy shortcut of a remote Linux application. The viewer shows a confirmation after it receives and writes a remote clipboard update.

Use a Unicode payload that includes ASCII, Chinese text, emoji, a newline, and a tab:

```text
UNICODE-L2R-R2L-中文-🙂-20260912
line-2	末尾
```

The validation passes only when the synchronized text is pasted into the remote editor byte-for-byte and a copy from the remote application is read back identically from the local clipboard.

## Local full-chain validation

The local demo uses a real VNC desktop, not a mock:

1. Start a local container with XFCE, TigerVNC, and noVNC.
2. Bind demo ports only to `127.0.0.1`.
3. Open the desktop through noVNC and verify screen, mouse, and keyboard input.
4. Verify Unicode text clipboard in both directions through noVNC extended clipboard.
5. Build the managed device image, run the device entrypoint, confirm that `127.0.0.1:5901` inside the container returns the `RFB 003.008` banner, and confirm Docker only publishes the session gateway / code-server ports.
6. Run backend, Executor, Wework, and Electron tests, then use the Wework AI verification tool for a real Electron smoke check.

## Security boundaries

- Raw VNC ports must not be published to browsers or the internet.
- Clients must not construct tokens or RFB addresses.
- The backend must not create VNC sessions without a valid live desktop capability.
- The Executor must not proxy non-loopback RFB targets.
- Clipboard access must be bound to a focused window and a lease so background pages cannot read or write the system clipboard.

## Acceptance checklist

- `runtime_features.schemaVersion` is 4 while old fields remain readable.
- The desktop entry appears only when a live desktop capability is present.
- `/devices/{device_id}/vnc` returns `type=vnc`, `transport=websocket`, and a `ws(s)://...` URL.
- The viewer only depends on `websocketUrl`.
- The gateway proxies WebSocket traffic to a loopback RFB server.
- The device image starts TigerVNC/XFCE and does not expose raw VNC ports.
- Clipboard round trips pass through a real VNC desktop.
