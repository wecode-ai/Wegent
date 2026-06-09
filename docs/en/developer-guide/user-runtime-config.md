---
sidebar_position: 26
---

# User Runtime Config

English | [简体中文](../../zh/developer-guide/user-runtime-config.md)

`UserRuntimeConfig` stores local CLI runtime configuration that only applies to the current user, such as Codex auth files and future Claude configuration. Resources are stored in the existing `kinds` table; no dedicated table is required.

## Storage

Each runtime uses one user-owned Kind resource:

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "UserRuntimeConfig",
  "metadata": {
    "name": "codex",
    "namespace": "default"
  },
  "spec": {
    "runtime": "codex",
    "auth": {
      "format": "json",
      "targetPath": "~/.codex/auth.json",
      "encryptedValue": "...",
      "sha256": "...",
      "updatedAt": "..."
    },
    "updatedAt": "..."
  }
}
```

The resource follows the normal Kind lookup rule: `user_id + namespace + name`. The `name` is the runtime identifier, for example `codex`. Future Claude support can add a `claude` resource.

Whether personal configuration is enabled is not stored in `UserRuntimeConfig`. It is a user preference stored in `users.preferences`:

```json
{
  "runtime_configs": {
    "codex": {
      "use_user_config": true
    }
  }
}
```

## Security

- Uploaded content must be valid JSON with an object at the top level.
- Backend storage uses `shared.utils.crypto.encrypt_sensitive_data()`.
- API responses only expose configuration state, timestamps, target path, and digest. Plaintext and ciphertext are never returned.
- Frontend state, toast messages, and sync results must not display auth content.

## Heartbeat Sync

After the user enables personal configuration, executor heartbeat reports whether the local Codex auth file exists. When Backend sees an online device missing `~/.codex/auth.json`, and the user's preferences enable Codex personal configuration with saved auth content, Backend syncs the auth file to that device in the background.

The sync path reuses Local Device Command RPC: Backend calls the whitelisted `sync_runtime_auth_file` command and passes auth content through environment variables so the command line logs do not contain auth data. Session startup only injects the personal-configuration state; it no longer decrypts or sends the auth file.

Device write rules:

- The target path must stay inside the current user's home directory.
- If the target file already exists, the command returns `skipped_existing` and does not overwrite it.
- If the target file does not exist, the command creates the parent directory and writes the file with `0600` permissions.

When importing from a device, Backend calls `read_runtime_auth_file`, validates the JSON, and stores it encrypted. The file content is not returned to Frontend.

## Extending Runtimes

To add a runtime, extend the Backend runtime registry with:

- Runtime identifier, for example `claude`
- Display name
- Auth file target path
- Validation strategy

After that, the runtime can reuse the same `/users/me/runtime-configs/{runtime}` APIs, settings toggle, encrypted storage, and heartbeat sync flow.
