---
sidebar_position: 7
---

# Devices and cloud work

Wework manages a local execution environment for local projects, conversations, Codex, and local models. Closing the window to the tray keeps local tasks running; quitting the application stops Wework-managed local processes.

## Connect to Wegent

Select **Connect to cloud**, enter the Backend address supplied by your team, choose **Authorize and connect**, and approve Wework on the authorization page.

The workbench then includes server models, cloud devices, and remote devices. Disconnecting does not remove local projects or conversations.

## Cloud and remote devices

When the cloud connection is available, select **Cloud work** in the sidebar to open its dedicated page instead of General settings. The page combines:

- Cloud and remote device status, executor version, terminal, IDE, and other device actions.
- CPU, memory, and disk usage for cloud devices, plus connection details, upgrade, restart, and delete actions. Version upgrades restart the cloud device so the Executor can update automatically during startup. During an upgrade or restart, the device briefly goes offline and the page reports progress until it reconnects.
- Projects associated with cloud or remote devices. Selecting a project returns to the standard task workbench with that project active.

Use **Connection settings** in the page header to open **Settings → Connections**. **Add device** opens the same settings page and starts the add-device flow. **New project** returns to the standard project creation flow, where the user chooses a device and a project directory on that device.

Select an online cloud device when creating a project or task. Its files, terminal, and commands stay on that device.

To add a self-managed machine, open **Settings → Connections → Add device**, choose a remote Docker device, and run the generated command on the target host. Treat the generated command as a credential.

### Device-side backend address resolution

The startup command writes the backend address into the device's environment (`WEGENT_BACKEND_URL`, `WEGENT_SOCKET_URL`). At runtime the Executor only reads the device's own configuration and never consults the backend's configuration. The `backend_url` resolution order is:

1. Device environment variables (`export` in the process script or `docker run -e`).
2. The device config file `$WEGENT_EXECUTOR_HOME/device-config.json`.
3. Self-healing derivation: when `backend_url` points at loopback (`localhost`, `127.0.0.1`, `::1`) and `socket_url` does not, the Executor derives `backend_url` from `socket_url` (`ws`→`http`, `wss`→`https`, preserving the port). A working Socket.IO connection proves the address is reachable, so devices provisioned with an early command that baked in `http://localhost:8000` recover after an Executor upgrade without regenerating the command.

When running a self-hosted backend, set `WEGENT_BACKEND_PUBLIC_URL` (and `WEGENT_SOCKET_URL` when it differs) to an address reachable from devices so newly generated commands carry the correct address.

Use **Copy to another device** in the task menu to continue work elsewhere. A running response is stopped before the copy is created.
