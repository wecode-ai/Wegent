---
sidebar_position: 6
---

# Desktop App Preferences

The Wework desktop app exposes window and background behavior in **Settings → General**. These preferences only affect the local desktop app. They do not change cloud tasks, model settings, or shell settings.

## Interface Language

**Interface language** changes the language used by the Wework desktop UI and the system tray menu. Users can choose **System**, **中文**, or **EN**.

When **System** is selected, Wework automatically uses Chinese or English based on the current system language. When **中文** or **EN** is selected manually, Wework saves the preference and restores it the next time the app starts.

## Workbench Background

Open **Settings → Appearance → Workbench background** to choose a local JPEG, PNG, or WebP image for the interface. Wework copies the image into its local app data directory, so moving or deleting the original file after selection does not remove the background.

By default, one image and one set of controls apply to both light and dark mode. Enable **Use different light and dark backgrounds** to configure the image, visibility, blur, and display areas independently for each mode. The first time this option is enabled, both mode-specific configurations inherit the current default settings. Disabling or re-enabling it later does not clear either the default configuration or previously edited mode-specific configurations.

**Background visibility** controls how strongly the image appears through the theme surface; at 100, the original image is shown clearly. **Background blur** ranges from 0–20px and defaults to 0. You can independently show the background in the main area, sidebar, and top bar. The corresponding settings-page regions follow the same choices.

When the background is enabled in the top bar, the image remains continuous behind the window controls without an additional solid titlebar strip.

When the background is enabled in the main area, it remains continuous across the conversation, right workspace, and bottom panels, including around the composer without an additional opaque bottom gradient.

The images and these appearance preferences stay on the current device and are not uploaded or synchronized. **Remove** deletes the managed image for the current configuration. **Reset** deletes every managed background image and restores all background preferences.

## Show the Main Window on Launch

When **Show main window on launch** is enabled, Wework opens the main window when the app starts. When disabled, the app starts in the system tray only, which is useful when you want task capability to stay available in the background.

When the main window is not visible, click the system tray icon to reopen it.

## Maximum Concurrent Tasks and the Task Queue

Under **Settings → General → Runtime**, choose how many tasks the current device may run at the same time. The supported range is 1–20, and the default is 10. Once the limit is reached, new tasks enter the device's waiting queue without sending a model request.

When the limit is increased, newly available execution slots immediately start waiting tasks in queue order, and the task list reflects their latest running state without waiting for another task to finish or requiring a manual refresh.

Queued tasks show their current position in the task list. Move a task forward or backward to change the real order used when execution slots become available. **Run now** temporarily lets a selected task exceed the configured limit. It does not interrupt work that is already running, and no additional queued task starts until the active count falls below the configured limit again.

The executor schedules the waiting queue in memory and stores a sealed recovery copy in the local application data directory. Pending tasks are restored in the saved order after Wework exits or restarts. The sealed file avoids plaintext exposure of queued credentials and detects tampering. Its key is stored in the same current-user-private application data directory, so it is not intended to protect against compromise of the local user account. The queue belongs only to the current device and is not uploaded or synchronized to another device.

## Popout Window

Open **Settings → General → Popout Window** to configure the lightweight input window that is independent of the main interface. The default global shortcut is `⌥⇧Space`. Select the pencil to record another modifier-plus-main-key combination, or select delete to disable the global shortcut.

Wework prewarms the Popout Window in the background after launch, so the first display and later reopens reuse the same WebView. The window is not resizable. Drag any visible surface outside the text input to move it, and press `Esc` to hide it without activating the main window. When collapsed, the native window occupies only the rounded visible composer surface, so clicking it focuses the window directly. Opening the model, project, or more menu temporarily expands the window to hold the overlay, then restores its compact size when the menu closes.

Enable **Settings → General → Popout Window → System drag panel** to show a compact action panel at the top of the current screen while dragging files or text from another application. Selecting **Create new chat** activates the Popout Window and adds the dropped content to a new task. Disable the setting to keep the system drag panel hidden.

New tasks start without a project. Use the project menu at the bottom of the composer to choose one, then use the more menu to select the current workspace or a new worktree, switch branches, and configure permissions. Wework remembers the user's latest selection the next time the Popout Window opens. After the first message is sent, the input window expands into a separate conversation window. **View in main window** closes the Popout Window and opens the current task in the main window, while **New message** returns to a fresh input state.

Tasks created from the Popout Window still run on the local execution device and immediately appear in the task list of an open main window without a manual refresh. The Popout Window and main window are separate native windows, so hiding or moving one does not reposition the other.

## Tray Display

**Settings → General → Tray display** independently controls unread completions, running tasks, Codex quota, and cloud quota. When **Codex quota** is enabled, the 5-hour and 7-day remaining quota appears next to the tray icon only when local Codex is available and its quota was read successfully. Wework does not show empty quota placeholders when Codex is unavailable. When **Cloud quota** is enabled, Wework displays the quota source's ASCII abbreviation (up to five letters) and remaining value next to the tray icon after a cloud connection is established and the quota is read successfully, for example `AIGC -85.68`.

The lower-left quota menu and the settings item use the full quota source name, such as `AIGC额度`. Usage rate is calculated from used value divided by total quota, and a negative remaining value is preserved to make over-quota usage explicit. The tray tooltip and settings menu identify whether the data belongs to Codex or the cloud quota source.

## Import from Other AI Apps

**Settings → General → Import work from other AI apps** imports compatible content from other local coding apps into Wework's separate Codex home. Importing replaces files with the same name in the destination, but does not remove content from the source app.

- **Codex**: Imports the same content as Wework's first-launch Codex migration, including configuration, sign-in information, global instructions, plugins, Skills, and related caches.
- **Claude Code**: Imports `~/.claude/CLAUDE.md` as the Codex global `AGENTS.md` and imports `~/.claude/skills/`.

The first release does not import project lists, Claude Code plugins, or conversation history. Import is available only in the Wework desktop app. If the source directory is missing or contains no compatible content, Wework keeps the dialog open and shows an error so the import can be retried after the source is fixed.

## Continue Running After Closing the Window

**Continue running in background after closing the main window** is enabled by default. When enabled, clicking the window close button does not quit Wework. Running tasks continue, and the app stays available from the system tray.

The first time you close the main window, Wework explains that tasks can continue after the window is closed. You can keep the window open or confirm that the app should move to the background. After confirmation, this explanation is not shown on every close.

After you select **Move to background**, the confirmation closes immediately and the main window then moves to the system tray. If the native window cannot close, the confirmation appears again so you can retry.

When Wework moves to the background, it destroys the main window WebView to release resources used by the UI. The task executor is not stopped. Reopening from the tray creates a new main window and restores the current task state.

When no conversation is open, the newly created main window keeps the task launcher within the window bounds. The message area scrolls as needed only after a conversation is opened.

## Prevent Sleep While Tasks Are Running

**Prevent sleep while tasks are running** is enabled by default. While at least one task is running, Wework prevents the computer from entering idle system sleep. This inhibition remains active when the main window is closed and Wework continues from the system tray.

After every task completes, fails, or is interrupted, Wework immediately releases the inhibition and restores the operating system's normal sleep policy. Wework does not force the computer to sleep and does not change the configured system sleep timeout.

On macOS, Wework prevents sleep with a system power assertion tied to the application process instead of starting a persistent `caffeinate` process. If Wework exits unexpectedly, macOS automatically releases the assertion, so no background process remains to keep blocking idle sleep.

To keep Wework from controlling sleep, disable this option under **Settings → General**. Disabling it immediately releases any current sleep inhibition. If it is enabled again while a task is still running, Wework resumes preventing idle sleep.

## Interface Recovery After Locking the Screen

On macOS, when the Wework main window remains unfocused for more than one minute, such as during an extended screen lock, Wework checks whether the WebView has resumed rendering when the window regains focus. A healthy interface is left unchanged. If the WebView still cannot acknowledge rendered frames within five seconds, Wework automatically recreates the main window while preserving its position, size, maximized state, and fullscreen state.

Automatic recreation affects only the interface process. It does not stop the Wework application process or local task executor, so running tasks continue. The recreated window restores the current task from persisted state, but unsent input that existed only in interface memory may not be preserved.

## Appshots

On macOS desktop, **Settings → Integrations → Appshots** shows the Appshots status and sound preference. The default shortcut is `⌘⇧2`. When pressed, Wework captures the frontmost application window and uses macOS Accessibility to read text exposed by that window, which can include text outside the visible scroll area. It then adds both the PNG and text context to the current composer attachments.

On first use, macOS requests Screen & System Audio Recording and Accessibility access. The former captures the image; the latter reads available window text. Allow both, restart Wework, and press the shortcut again. Wework does not show an additional in-app permission dialog. If access was previously denied, check its status under Appshots settings and select the corresponding **Open System Settings** action to grant it.

Text extraction depends on the accessibility information exposed by the target application. Some apps and websites expose only visible content, so complete off-screen text is not guaranteed for every window.

Appshots are stored in Wework's local attachment draft directory and are used only as current composer attachments. They are not uploaded to Backend unless the user later sends a message containing the attachment.

The **Play sound** switch controls whether macOS plays the system screenshot sound after a successful capture. Turning it off still creates the snapshot and adds it to the composer.

## Quit the App

To fully quit Wework, choose quit from the system tray menu. Quitting the app stops local executor processes.

On macOS, you can also choose **Quit Wework** from the application menu after the main window has been closed to the system tray. This fully exits the app instead of being intercepted by the close-to-tray window lifecycle.

If **Continue running in background after closing the main window** is disabled, clicking the window close button quits the app instead of moving it to the tray.
