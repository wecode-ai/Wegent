---
sidebar_position: 2
---

# Nevis Cloud Device VNC Desktop

Internal-only provider behind the public desktop contract documented in `docs/en/wework/developer-guide/wework-device-vnc-desktop.md`. Keep this page, its settings, and the provider implementation inside the internal distribution.

## Provider configuration

```env
NEVIS_BASE_URL=https://nevis.example.com
NEVIS_MANAGER_ID=manager-id
NEVIS_SIGNATURE=<signature>
```

Backend reads these settings only while preparing or re-authorizing an upstream connection. They are excluded from REST responses, Redis session records, browser logs, and metric labels.

## Registration

`wecode/service/vnc_session_provider.py` registers `NevisVncSessionProvider` for `DeviceType.CLOUD` on the public registry, and `wecode/api/__init__.py` imports that module for its registration side effect. No other device type has a VNC provider, so Remote, local, and other devices fail closed.

## Session flow

`prepare` runs both while creating an HTTP session and immediately before opening the upstream WebSocket:

1. Reject the request when `cloud_device_provider` is not configured.
2. Load the device status and require the caller-owned sandbox identity (`cloudConfig.sandboxId`).
3. Query the live sandbox and require a ready state (`ready` or `running`).
4. Require a non-empty `NEVIS_SIGNATURE`.
5. Build the Backend-only endpoint
   `{NEVIS_BASE_URL}/apis/sandboxes/v1/managers/{NEVIS_MANAGER_ID}/sandboxes/{sandbox_id}/vnc`
   and return it with the `X-Signature` header.

`authorize` calls `prepare` again and rejects the connection when the sandbox identity changed since the session was created, so a recreated sandbox cannot inherit a live session.

`vnc_session_provider.py` also registers `cloud_device_provider.get_vm_status` as the cloud session host resolver, which keeps the desktop URL and the device session URL pointing at the same sandbox.

## Security guarantees

- The signature is read from settings on each prepare, never persisted to Redis, and never returned to the client.
- The client and Wework only ever receive the short-lived `/vnc-proxy/sessions/<id>?ticket=...` URL; the Nevis URL, manager ID, sandbox ID, and signature stay in the Backend.
- The provider never overrides the owner resolved during the authenticated HTTP request.
- Sandbox identity changes invalidate an existing session instead of silently reconnecting.
