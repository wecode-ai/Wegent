---
sidebar_position: 12
---

# Internal API Key Identity Lookup

Trusted clients or services can call `POST /api/internal/api-keys/lookup` to
check whether a Wegent-issued API key is valid and resolve its identity. The
endpoint accepts a raw key and requires service authentication using
`INTERNAL_SERVICE_TOKEN`.

## Request

```http
POST /api/internal/api-keys/lookup
Authorization: Bearer <INTERNAL_SERVICE_TOKEN>
Content-Type: application/json

{"api_key": "wg-<api-key>"}
```

`api_key` is a required, nonempty string. Missing or empty values return HTTP
422. A missing, invalid, or unconfigured internal authentication token returns
HTTP 401.

## Lookup Order and Identity

1. Look up the SHA256 hash across service keys created by any administrator,
   without filtering by creator. The key must start with `wg-`, be active, and
   be unexpired. A match returns the service key's **name** with
   `key_type: "service"` immediately.
2. If no valid service key matches, look up a personal key. It must also be
   active and unexpired, and its owner must exist and be active. Return the
   owner's username with `key_type: "personal"`.
3. If no valid key matches, return `exists: false` with null identity fields.

A service key's `user_id` records the administrator who created it, rather
than the service identity. The lookup uses the key name as the service account
name, so it does not return the administrator's username or depend on the
creator's active status. Plugin release keys are excluded from this endpoint.

## Response

Both a valid match and a lookup without a valid match return HTTP 200.

| Field | Type | Meaning |
| --- | --- | --- |
| `exists` | boolean | Whether a valid key matched |
| `user_name` | string or null | Service key name or personal key owner's username |
| `key_type` | `service`, `personal`, or null | Matched key type; null without a match |

Service key:

```json
{"exists": true, "user_name": "model-proxy-service", "key_type": "service"}
```

Personal key:

```json
{"exists": true, "user_name": "alice", "key_type": "personal"}
```

Invalid, disabled, expired, or unknown key:

```json
{"exists": false, "user_name": null, "key_type": null}
```

The existing `exists` and `user_name` fields are retained. `key_type` is a new
optional field. Existing clients can keep reading the first two fields; clients
that distinguish service and personal identities should read `key_type`.

The lookup does not update `last_used_at`, create users, or modify keys.
Executor authentication continues to accept only personal keys; recognizing
service keys here does not change executor authentication rules. The default
hybrid gateway routes this endpoint to the Python backend.
