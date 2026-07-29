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
- CPU, memory, and disk usage for cloud devices, plus connection details, restart, and delete actions.
- Projects associated with cloud or remote devices. Selecting a project returns to the standard task workbench with that project active.

Use **Connection settings** in the page header to open **Settings → Connections**. **Add device** opens the same settings page and starts the add-device flow. **New project** returns to the standard project creation flow, where the user chooses a device and a project directory on that device.

Select an online cloud device when creating a project or task. Its files, terminal, and commands stay on that device.

To add a self-managed machine, open **Settings → Connections → Add device**, choose a remote Docker device, and run the generated command on the target host. Treat the generated command as a credential.

Use **Copy to another device** in the task menu to continue work elsewhere. A running response is stopped before the copy is created.
