---
sidebar_position: 10
---

# Troubleshooting

## Models and tasks

- Check Codex sign-in or the local model URL under **Settings → Models**.
- Confirm that the selected model can run on the selected device.
- Restart Codex when prompted after changing a proxy.
- For task or terminal failures, check whether the device is online, busy, or requires an update.

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

When reporting a problem, include the Wework version, operating system, reproduction steps, visible error, and relevant logs. Remove tokens, API keys, device commands, and authentication-file contents.
