---
sidebar_position: 5
---

# Project Codex Settings

The Wework desktop app can configure Codex instructions and plugins separately for each local project. Open a project's menu and select **Project settings** to edit the native Codex project files through a graphical interface.

## Relationship to Native Codex Configuration

Project settings do not introduce a Wework-specific configuration format:

- **Project instructions** reads and writes `AGENTS.md` at the project root. Codex combines it with user-level and parent-directory instructions according to its native instruction discovery and layering rules.
- **Codex config** reads and writes `.codex/config.toml` at the project root.
- Project plugins are stored as `[plugins."<plugin-key>"]` entries in `.codex/config.toml`. They are added to globally enabled plugins; they do not replace the global plugin set.
- Plugin packages are shared by the local Codex installation. **Install for this project** installs the shared package, keeps it disabled globally, and enables it in the current project.

Settings made in Wework are therefore available when Codex is run directly in the project directory. If the native files are edited manually, reopening the page in Wework displays their latest contents.

## When Changes Take Effect

Saving checks the file revision to avoid silently overwriting newer disk changes. Codex loads project instructions, configuration, and plugins when a new session starts; the settings page does not force an already running session to restart.

Before committing `AGENTS.md` or `.codex/config.toml`, verify that they contain no secrets, tokens, or machine-specific paths. When the files are intended for the whole team, they can be versioned in Git like other project files.
