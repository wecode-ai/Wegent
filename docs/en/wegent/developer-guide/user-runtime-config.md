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

The personal proxy configuration uses an independent user-owned Kind resource so it is not tied to one runtime:

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "UserProxyConfig",
  "metadata": {
    "name": "default",
    "namespace": "default"
  },
  "spec": {
    "proxy": {
      "encryptedUrl": "...",
      "sha256": "...",
      "updatedAt": "..."
    },
    "updatedAt": "..."
  }
}
```

Resources follow the normal Kind lookup rule: `user_id + namespace + name`. For `UserRuntimeConfig`, `name` is the runtime identifier, for example `codex`; future Claude support can add a `claude` resource. For `UserProxyConfig`, `name` is fixed to `default`, representing the current user's default personal proxy.

Whether personal configuration is enabled and whether a runtime uses the personal proxy are not stored in Kind resources. They are user preferences stored in `users.preferences`:

```json
{
  "runtime_configs": {
    "codex": {
      "use_user_config": true,
      "use_proxy": true
    }
  }
}
```

## Security

- Uploaded content must be valid JSON with an object at the top level.
- Backend storage uses `shared.utils.crypto.encrypt_sensitive_data()`.
- API responses only expose configuration state, timestamps, target path, and digest. Plaintext and ciphertext are never returned.
- Proxy URLs are also stored encrypted; API responses only include a masked display value.
- Frontend state, toast messages, and sync results must not display auth content.

## Execution Proxy

Personal proxy configuration is injected only at execution time. It is not synced into device auth files. When Backend builds an execution request, it includes top-level `proxy.url` only if the user enabled `use_proxy` for `codex` and saved a proxy URL in `UserProxyConfig/default`. Consumers decide whether to use that proxy based on their own runtime switch.

executor injects the proxy URL into the Codex SDK environment as `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and the matching lowercase variables. `NO_PROXY` follows these rules:

- If the executor environment already has `NO_PROXY` or `no_proxy`, keep that value.
- Otherwise, use `localhost,127.0.0.1,::1,host.docker.internal` so local stdio/localhost style access bypasses the proxy.

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
