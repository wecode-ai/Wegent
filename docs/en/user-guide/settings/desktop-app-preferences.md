---
sidebar_position: 6
---

# Desktop App Preferences

The Wework desktop app exposes window and background behavior in **Settings → General**. These preferences only affect the local desktop app. They do not change cloud tasks, model settings, or shell settings.

## Interface Language

**Interface language** changes the language used by the Wework desktop UI and the system tray menu. Users can choose **System**, **中文**, or **EN**.

When **System** is selected, Wework automatically uses Chinese or English based on the current system language. When **中文** or **EN** is selected manually, Wework saves the preference and restores it the next time the app starts.

## Show the Main Window on Launch

When **Show main window on launch** is enabled, Wework opens the main window when the app starts. When disabled, the app starts in the system tray only, which is useful when you want task capability to stay available in the background.

When the main window is not visible, click the system tray icon to reopen it.

## Import from Other AI Apps

**Settings → General → Import work from other AI apps** imports compatible content from other local coding apps into Wework's separate Codex home. Importing replaces files with the same name in the destination, but does not remove content from the source app.

- **Codex**: Imports the same content as Wework's first-launch Codex migration, including configuration, sign-in information, global instructions, plugins, Skills, and related caches.
- **Claude Code**: Imports `~/.claude/CLAUDE.md` as the Codex global `AGENTS.md` and imports `~/.claude/skills/`.

The first release does not import project lists, Claude Code plugins, or conversation history. Import is available only in the Wework desktop app. If the source directory is missing or contains no compatible content, Wework keeps the dialog open and shows an error so the import can be retried after the source is fixed.

## Continue Running After Closing the Window

**Continue running in background after closing the main window** is enabled by default. When enabled, clicking the window close button does not quit Wework. Running tasks continue, and the app stays available from the system tray.

The first time you close the main window, Wework explains that tasks can continue after the window is closed. You can keep the window open or confirm that the app should move to the background. After confirmation, this explanation is not shown on every close.

When Wework moves to the background, it destroys the main window WebView to release resources used by the UI. The task executor is not stopped. Reopening from the tray creates a new main window and restores the current task state.

## Quit the App

To fully quit Wework, choose quit from the system tray menu. Quitting the app stops local executor processes.

If **Continue running in background after closing the main window** is disabled, clicking the window close button quits the app instead of moving it to the tray.
