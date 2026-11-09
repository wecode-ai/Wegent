---
sidebar_position: 7
---

# Devices and cloud work

<!-- ui-source: src/components/settings/ConnectionsSettingsPage.tsx -->

## Individual device-card operations

Open **left sidebar → Cloud work**. **Connection settings** at the top right opens **Settings → Personal → Cloud connection**, not a project's execution-environment page.

| Feature                       | Steps and result                                                                          | Conditions and limits                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Connect/disconnect Wegent     | Authorize and connect on the cloud connection page; disconnect with its connection action | Preserves local projects/conversations; model/device lists change with connectivity        |
| Add device                    | Add device → type → wizard                                                                | Remote Docker commands contain credentials; run securely on the target machine             |
| Status, resources and version | Inspect the card and expand details                                                       | Offline differs from a loading error; inspect errors first                                 |
| Terminal / IDE / Desktop      | Choose the supported card operation                                                       | Runs on that device, not an arbitrary directory on this computer                           |
| Connection information        | Device actions → connection information                                                   | Do not copy credentials into chat or public documentation                                  |
| Upgrade / restart             | Choose the device action and review confirmation                                          | Temporarily goes offline; wait for progress and recovery rather than submitting repeatedly |
| Delete device                 | Device actions → delete, verify target and confirm                                        | Neither a backup nor deletion of remote project directories                                |
| New project                   | Cloud work → New project → device and directory                                           | Cloud sign-in does not automatically select cloud execution                                |

Wework manages a local execution environment for local projects, conversations, Codex, and local models. Closing the window to the tray keeps local tasks running; quitting the application stops Wework-managed local processes.

## Connect to Wegent

<!-- ui-source: src/pages/LoginPage.tsx -->
<!-- ui-source: src/pages/OidcCallbackPage.tsx -->
<!-- ui-source: src/pages/WeworkAuthorizePage.tsx -->

### Login and authorization return

Depending on deployment, the authorization flow may show password login or the organization's OIDC button. Administrator password setup appears only when the service requires initial administrator setup; ordinary users should not initialize an administrator account.

Choose the offered login method and follow it. The app handles OIDC callbacks; do not manually enter code, state, tokens or callback addresses. Return to Wework after its authorization-success message. Opening the website or signing in alone does not prove the device connection completed. Restart from the original connection entry after an error, preserving its message without sharing credential-bearing links in chat.

Select **Connect to cloud**, enter the Backend address supplied by your team, choose **Authorize and connect**, and approve Wework on the authorization page.

The workbench then includes server models, cloud devices, and remote devices. Disconnecting does not remove local projects or conversations.

## Cloud and remote devices

In the desktop app, **left sidebar → Cloud work** includes local recovery guidance in the device section. The current Wework app manages local execution; local devices are not mixed into cloud and remote device cards. For incompatible local versions, select **View local version** to open **Settings → Personal → About**, use the existing update controls, follow any upgrade and restart instructions, then select **My stand-in** in the Cloud work sidebar to return and reload. This entry remains available without cloud devices or a cloud connection, but is hidden in web browsers. Selecting it only navigates; it does not install or restart anything automatically.

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
