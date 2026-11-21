---
sidebar_position: 16
---

# Device connection runtime releases

The Remote Docker image builds the Executor and Node/DSH connection runtime from the same revision. Connection services and runtime permission checks share account discovery: device credentials (`wg-`) use `/devices/runtime-owner`, while desktop sessions use `/users/me`. Before release, confirm that the test Backend supports device identity and connection events, and check the four `runtime-observations` routes in its active Rust route table.

The GitHub `Wegent Release` workflow builds amd64 and arm64 device images, verifies their version, source revision and architecture, and checks the connection runtime manifest and delivered Node executable. Record the candidate image digest and set the test environment's `REMOTE_DEVICE_DOCKER_IMAGE` to that digest.

## Remote Docker

Use the generated command for new devices. Before upgrading, record the previous image digest, launch arguments and both volume mounts. Let active work finish and stop the old container. Recreate it with the candidate digest and the original device ID, credentials, network and mounts. Use the previous digest to roll back. Run one writer per volume.

For a legacy single-volume device, retain the volume at `/home/wegent/.wecode/wegent-executor` and add a persistent volume at `/home/wegent/.wegent`. After stopping the old container, copy any existing data at that path into the new volume, preserving paths and ownership. Keep separately mounted workspaces and Codex homes. The entrypoint preserves existing Codex home settings and refreshes only the Executor binary and connection runtime link.

If both Executor homes contain data, use the old process's launch arguments, environment and resolved paths to verify the active home. Stop the container, back up each home separately, and recreate it with the corresponding configuration:

- For an active legacy home, explicitly set `WEGENT_EXECUTOR_HOME=/home/wegent/.wecode/wegent-executor` and retain its original volume mount and the `/home/wegent/.wegent` data volume.
- For an active unified home, set `WEGENT_EXECUTOR_HOME=/home/wegent/.wegent/workbench/executor` and retain its containing `/home/wegent/.wegent` data volume and any original nested mounts. Remove the inactive legacy volume mount at `/home/wegent/.wecode/wegent-executor` from the new container's launch arguments, keeping that volume and the original arguments for rollback. If the unified path resolves to the legacy home, follow the legacy configuration instead.

Both configurations must retain the verified device identity, separately mounted workspaces, and Codex home configuration and mounts. Do not merge the two homes or delete the inactive volume; verify the active home before recreating the container. Selecting an existing unified home while retaining the legacy volume mount triggers `Both legacy and unified Executor Homes exist`, and the entrypoint refuses to start.

Run persistence acceptance in an isolated Docker environment with separate previous, candidate and rollback image references. The optional `WEGENT_REMOTE_DEVICE_ACCEPTANCE_PLATFORM` selects `linux/amd64` or `linux/arm64`.

```bash
WEGENT_REMOTE_DEVICE_ACCEPTANCE_PLATFORM=linux/amd64 \
WEGENT_REMOTE_DEVICE_ACCEPTANCE_IMAGE='<previous-image-digest>' \
WEGENT_REMOTE_DEVICE_REBUILD_IMAGE='<candidate-image-digest>' \
WEGENT_REMOTE_DEVICE_ROLLBACK_IMAGE='<previous-image-digest>' \
bash scripts/acceptance/remote-device-worktree-persistence.sh
```

Acceptance reuses the device identity and both volumes through initial startup, candidate recreation and rollback recreation. It checks mounts, the current image binary, existing sessions and workspace data, and rejects device rebinding and concurrent writers. Without image overrides, recreation and rollback use the initial image; this verifies same-image recreation rather than a cross-version upgrade.

## Rollout

Check a fresh install, direct upgrade and rollback. Confirm existing sessions still work, and exercise real connection event delivery, reconnection, deduplication and cancellation. The existing desktop CI `conversation-event-remote-docker` scenario verifies event recovery with a real Backend, DSH and Docker device, using a model-service test double. Promote the default image after persistence and event acceptance pass.
