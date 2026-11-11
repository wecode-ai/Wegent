---
sidebar_position: 2
---

# Quick start

<!-- ui-source: src/pages/HomePage.tsx -->

## Install and launch

Download the latest complete Wework installer for your system and update
channel from your team or the
[latest Wegent Desktop Release](https://github.com/wecode-ai/Wegent/releases/latest).
Launch Wework after installation.

On first launch, Wework prepares its local runtime. Import an existing Codex configuration when prompted, or open **Settings → Models** later to sign in to Codex or add another model.

If the initial privacy prompt appears, read the collection notice and choose **Allow sharing** or **Don't share**. Change this later under **Settings → General → Privacy**. Declining sharing does not prevent ordinary local tasks; enabling it is not a prerequisite for work.

## Run your first task

1. Select **New task** in the sidebar.
2. Choose an available model in the composer.
3. Enter a focused request, such as “Explain this project's directory structure and how to run it locally.”
4. Send the message and follow the execution.

A conversation without a project uses a standalone workspace. Create a project first when AI needs to work on existing code.

## Open a local project

1. Use the add button beside Projects.
2. Select **Local project**.
3. Choose the project root in the system folder picker.
4. Open the project and describe the task.

Adding a project does not move its files. Removing a local project from Wework does not delete its folder.

<a id="startup-recovery"></a>

## Startup recovery

Wework keeps an operable window available when release records, migrations, credentials, or local components fail. Unaffected workbench features remain available; an unavailable local service shows a notice with a retry action. When settings or durable state cannot be read, the interface uses temporary state and refuses to overwrite the original file. Saving can resume after the file is repaired.

The workbench also remains available if its first state save fails. That state stays temporarily in memory and is not yet saved to disk. After the write failure is repaired, subsequent saves preserve the initial state.

If the core runtime cannot load, Wework opens an independent **Wework Recovery Center**. Choose **Copy diagnostics** for the failure details or **Open log folder** to inspect logs, then choose **Retry startup** after repairing the cause. These actions do not automatically clear tasks, configuration, credentials, or snapshots. Opening recovery does not certify that the normal runtime is healthy.
