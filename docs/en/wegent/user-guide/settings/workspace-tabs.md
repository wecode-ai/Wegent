---
sidebar_position: 8
---

# Workbench tabs

The Wework workbench uses two browser-like tab types:

- **Fixed tabs** are created whenever Wework starts and always occupy the first positions in the tab strip.
- **Regular tabs** are created temporarily from the **+** menu and remain only for the current session. They are not restored after restart.

## Configure fixed tabs

The default fixed tabs include Tasks, Workspace view, Agent, and **Needs your input**. Existing custom fixed-tab lists are preserved.

Open **Settings → General → Fixed tabs** to:

1. Add Tasks, Workspace view, Agent, or an installed Smart workbench.
2. Reorder fixed tabs.
3. Choose which fixed tab is selected after launch.
4. Remove tabs that should not open automatically.

Fixed tabs cannot be closed from the tab strip. Removing one from the fixed list prevents it from appearing on the next launch without interrupting a page that is already open in the current session.

## Add tabs from the tab strip

Select the **+** button beside the tab strip to directly add:

- Tasks
- Workspace view
- Agent
- Needs your input
- Installed Smart workbenches
- Smart workbench management

Tabs added from **+** are regular tabs by default. To make a Smart workbench available after every launch, add it under **Settings → General → Fixed tabs**.

**Needs your input** reuses its existing tab and shows the live pending count in the title, such as **Needs your input (2)**. Once all items are handled, it shows **Needs your input (0)**. This entry is available without experimental features. To pin it, right-click its tab and select **Pin tab**.

## Smart workbench launch behavior

A fixed Smart workbench starts automatically with its tab. A regular Smart workbench starts when the user opens its tab. After installation, a Smart workbench immediately appears in both the **+** menu and the fixed-tab picker.
