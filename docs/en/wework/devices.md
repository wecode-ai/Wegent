---
sidebar_position: 7
---

# Devices and cloud work

<!-- ui-source: src/components/settings/ConnectionsSettingsPage.tsx -->

If the device list fails to load, it shows the error and a **Retry** action. A failed refresh preserves devices already read for the current connection; switching cloud accounts never carries over the previous account’s list.

## Individual device-card operations

Open **left sidebar → Cloud work**. **Connection settings** at the top right opens **Settings → Personal → Cloud connection**, not a project's execution-environment page.

| Feature                       | Steps and result                                                                          | Conditions and limits                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Connect/disconnect Wegent     | Authorize and connect on the cloud connection page; disconnect with its connection action | Preserves local projects/conversations; model/device lists change with connectivity        |
| Add device                    | Add device → type → wizard                                                                | Remote Docker commands contain credentials; run securely on the target machine             |
| Status, resources and version | Inspect the card and expand details                                                       | Offline differs from a loading error; inspect errors first                                 |
| Terminal / IDE / Desktop      | Choose the supported card operation                                                       | Runs on that device, not an arbitrary directory on this computer                           |
| Connection information        | Device actions → connection information                                                   | Do not copy credentials into chat or public documentation                                  |
| Restart device             | Choose Restart device in the card menu or select the Update available badge, then review the confirmation                                          | Temporarily goes offline; wait for progress and recovery rather than submitting repeatedly |
| Delete device                 | Device actions → delete, verify target and confirm                                        | Neither a backup nor deletion of remote project directories                                |
| New project                   | Cloud work → New project → device and directory                                           | Cloud sign-in does not automatically select cloud execution                                |

Wework manages a local execution environment for local projects, conversations, Codex, and local models. Closing the window to the tray keeps local tasks running; quitting the application stops Wework-managed local processes.

## Access this computer's tasks from a phone or another computer

On the computer that should execute tasks, open **Settings → Personal → Cloud connection** and enable **Allow remote access to tasks on this computer**. The switch defaults to off and is stored only on that computer. Other devices signed in to the same account cannot change it.

If local settings fail to load, the switch stays disabled. Click **Retry** beside the error to read the settings again. Changing the interface language does not interrupt a pending save.

Once enabled, phones and other computers using the same account can select this online computer to view, create, and continue its tasks. Operations execute on the selected computer. Each installation manages its own switch independently, and the current computer is not duplicated in its own remote device list.

Turning the switch off blocks subsequent remote task access. Keep Wework running and connected to the cloud on the target computer. This setting does not additionally expose device terminals or IDE access.

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
- CPU, memory, and disk usage for cloud devices, plus connection details, restart, and delete actions. During a restart, the device briefly goes offline and running tasks may be interrupted, including tasks on other devices in the same sandbox. The page reports progress until the device reconnects. Check the Executor version reported after reconnection. Restart requires a deployment-provided implementation. The app reports when restart is unavailable.
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

<a id="collaboration-device-defaults"></a>

## Collaboration defaults and offline registrations

Open **Collaboration → Collaboration management → Execution devices** and choose an online device under **Personal default environment**. Changes save immediately. If the saved default is unavailable, **Clear default device** removes the old preference; offline devices stay out of the options.

Under **Collaboration → New Issue**, expand the initially collapsed **Runtime (optional)** section below the Issue properties. **Personal default environment** is separate from those properties. Selecting or clearing a device changes the personal preference only after **Save personal default device**; it applies to tasks started later and never starts the Issue automatically. Canceling an Issue does not save an unconfirmed selection or undo an explicitly saved personal preference. Selecting a project instead shows **Project device access (applies immediately)**: **Choose or add a device** reuses the project's grant flow in a popover. Grants apply immediately and survive canceling the Issue; closing the popover preserves the draft. Device setup can also wait until after Issue creation. Project permissions and fixed Agent policies are still checked at execution.

The directory and available choices show online devices only. If a pending Issue-form selection becomes unavailable, its name remains visible with an Unavailable label, so the displayed choice stays explicit. Concurrent application installations on one computer may have separate entries; local and registered views of the same Runtime are joined. Offline registrations older than seven days are automatically deactivated only when they have no queued or running work. Tasks and execution history are retained. Failed status reads never permit cleanup; legacy records without a known last-online time begin their retention period when first observed offline.
