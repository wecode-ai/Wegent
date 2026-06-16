---
sidebar_position: 31
---

# Shared Skill Directory

Wework provides a Skills settings page that unifies local Claude and Codex personal skill directories under `~/.agents/skills`. The feature targets online Claude Code local devices and runs through local device command RPC; the browser does not access the filesystem directly.

## Directory Layout

After enabling the option, the local device uses this layout:

```text
~/.agents/skills          # Shared skill directory
~/.codex/skills -> ~/.agents/skills
~/.claude/skills -> ~/.agents/skills
```

Existing entries from `~/.codex/skills` and `~/.claude/skills` are moved into `~/.agents/skills` first. The two legacy paths are then replaced with symlinks to the shared directory. Running the operation again is idempotent; if both legacy paths already point at the shared directory, the command reports that they are already configured.

## Conflict Handling

Migration never overwrites existing skill directories. If `~/.codex/skills` and `~/.claude/skills` contain entries with the same name, the later migrated entry receives a source suffix such as `browser-claude`. The command result includes `moved_count`, `moved[].renamed`, and final paths. The Wework settings page reports the number of migrated entries and automatic renames.

If a legacy path is already a symlink to another location, or exists but is not a directory, the command fails with an error instead of modifying the user's existing layout.

## Skill Scanning

`ls_skills` scans `~/.agents/skills` first and marks those skills as `source=agents`. Wework local skill autocomplete treats `agents` skills as compatible with both Claude and Codex models, so shared skills are not disabled by the selected model runtime.

Plugin skills are still scanned from `~/.claude/plugins/cache` and `~/.codex/plugins/cache`; they are not migrated into the shared directory.

## Entry Points And Command

Frontend entry points:

- Desktop: Settings -> Code -> Skills
- Mobile: Settings -> Skills

Built-in Backend command key:

```text
setup_shared_skills
```

The command is registered in `backend/app/services/device/command_registry.py` and returns a JSON object. The frontend calls `/devices/{device_id}/commands` through `createDeviceApi().setupSharedSkills(deviceId)`.
