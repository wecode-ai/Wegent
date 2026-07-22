---
sidebar_position: 10
---

# Troubleshooting

## Models and tasks

- Check Codex sign-in or the local model URL under **Settings → Models**.
- Confirm that the selected model can run on the selected device.
- Restart Codex when prompted after changing a proxy.
- For task or terminal failures, check whether the device is online, busy, or requires an update.

### A new task is missing from the sidebar

For development diagnostics, run the following command in the Wework Web Inspector console, then reproduce the issue:

```js
localStorage.setItem("wework:debug-runtime", "1");
```

`[Wework] Runtime sidebar state` entries in the frontend log record the executor list result, the merged state, and the task IDs left visible or hidden by sidebar sorting and truncation. If the selected task belongs to the project task list but is outside the visible region, Wework also records `[Wework] Runtime sidebar selected task is hidden`. Run `localStorage.removeItem('wework:debug-runtime')` after diagnosis to disable detailed logging.

## Projects and Git

- Confirm that a local folder exists and is writable.
- Re-select the folder on an online device for a remote project.
- For Git authentication errors, verify the token and repository permissions.
- Check the repository URL, default branch, device network, and proxy for clone failures.

## Reviews and browser

Change review and undo require the original device and per-turn artifact. Resolve later conflicting edits manually.

For browser failures, include `http://` or `https://`, confirm that local servers are listening, and clear browser data only when you are ready to sign in again.

## Cloud connection

Select the cloud status in the sidebar to authorize again. Verify the Backend address with your administrator and confirm that its sign-in page is reachable.

## Getting help

Select **Report a problem** in the upper-right corner of the affected task, choose the information to include, and select **Export diagnostics**. Wework saves the bundle in the system Downloads directory. Additional information is optional.

The bundle includes the following items by default:

- Complete Wework and local runtime logs.
- Current task, device, and runtime state.
- A screenshot of the current task.
- Wework version, operating system, and processor architecture.

You can deselect any item before exporting. The bundle is generated only on the local computer and is never uploaded automatically. Wework redacts common credentials and the user home path, but you should still review the bundle before sharing business-sensitive information.
