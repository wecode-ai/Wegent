---
sidebar_position: 5
---

# Keyboard Shortcuts

The Wework desktop app provides local keyboard shortcuts when running in Tauri. Shortcut settings are stored only on the current device. They are not written to Backend and are not synced through a cloud connection.

## Open Settings

In the Tauri desktop app, open **Settings → Personal → Keyboard Shortcuts** to view and edit local shortcuts. Each row shows the command name, description, current key binding, and actions to reset or clear the binding.

After a shortcut is changed, Wework refreshes the shortcut listeners in the current window immediately.

## Default Shortcuts

| Command             | Default binding             | Description                                                              |
| ------------------- | --------------------------- | ------------------------------------------------------------------------ |
| Toggle bottom panel | `Command+J`                 | Show or hide the bottom panel; opening it starts the terminal by default |
| Open settings       | `Command+,`                 | Open the settings page                                                   |
| Go back             | `Command+[` / Mouse Back    | Go back in navigation history                                            |
| Go forward          | `Command+]` / Mouse Forward | Go forward in navigation history                                         |
| Toggle sidebar      | `Command+B`                 | Show or hide the left sidebar                                            |
| Toggle side panel   | `Alt+Command+B`             | Show or hide the right workspace panel                                   |
| Choose model        | `Control+Shift+M`           | Open or close the model selector for the active composer                 |

Registered global shortcuts still work when focus is inside the chat composer or terminal. Normal text input is not intercepted.

## Local Storage

User shortcut overrides are stored in the local executor runtime-work directory:

```text
<WEGENT_EXECUTOR_HOME>/runtime-work/keybindings.json
```

When `WEGENT_EXECUTOR_HOME` is not set, the default path is:

```text
~/.wegent-executor/runtime-work/keybindings.json
```

The file contains an array. Each item has a command and the user override key. A `null` key means the command binding is cleared.

```json
[
  {
    "command": "openSettings",
    "key": "Command+,"
  },
  {
    "command": "openTerminal",
    "key": null
  }
]
```

Wework built-in defaults are not written into this file. Only user overrides, resets, and clears are persisted.
