---
sidebar_position: 7
---

# System Operation Record and Replay

The Wework desktop app can record mouse clicks, keyboard events, scrolling, and foreground application context on macOS, then replay those actions in their original order. Recordings stay on the current device and are not synchronized to the cloud.

## Prepare macOS Permissions

Open **Record & Replay** from the left navigation. The first use requires these permissions in macOS System Settings:

- **Accessibility**: reads operation targets and controls other applications during replay.
- **Input Monitoring**: captures global mouse, keyboard, and scroll events.

You can start recording after the permission card shows **Allowed**. If Accessibility is already allowed but Input Monitoring is not, the settings button opens the Input Monitoring permission page directly. macOS may require Wework to restart after a permission change.

## Record System Operations

1. Enter a recognizable recording name.
2. Select **Start recording**.
3. Switch to the target applications and perform the actions you want to save.
4. Return to Wework and select **Stop and save**.

While recording, the page shows the captured step count and current application. After saving, the recording library shows the name, creation time, step count, and number of involved applications.

## Replay and Stop

Select **Replay** for an item in the recording library. Wework executes the steps in their recorded relative order and shows the current step and application.

Select **Stop replay** to cancel an active replay immediately. After a replay completes or is canceled, you can start another recording, replay again, or delete the recording. Quitting Wework also stops any active recording or replay helper process.

## Safety Limits

- Sensitive keyboard input, such as passwords, is not stored.
- Wework pauses instead of automatically continuing when it detects a protected or high-risk system target.
- Replay can switch to and operate other applications. Save unfinished work first and make sure target applications are in a state similar to the original recording.
- Deleting a recording removes it from the local recording library on the current device.

## Troubleshooting

If recording or replay cannot start:

1. Confirm that you are using the macOS desktop app. Other platforms are not currently supported.
2. Check that the permission card reports both Accessibility and Input Monitoring as allowed.
3. Remove and grant the Wework permissions again in macOS System Settings, then restart the app.
4. If an operation fails, wait for the page to return to an actionable state and retry directly; restarting Wework is not required.
