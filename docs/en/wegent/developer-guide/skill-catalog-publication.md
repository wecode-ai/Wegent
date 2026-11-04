---
sidebar_position: 35
---

# Package and publish document Skills

`backend/skill_catalogs/document.json` describes five standard Skill ZIPs.
Chat uses `document` with its provider and tools. ClaudeCode and Codex use
`docx`, `xlsx`, `pptx`, and `pdf`. Devices download selected packages
through the standard Skill endpoint, cache them by content hash, and use a
private Skill snapshot for each execution.

Get complete packages at pinned versions from trusted Skill sources. The
`chat` source root contains the original `document/` directory. The
`native` source root contains the four complete format-specific directories.

```bash
cd backend
uv run python scripts/package_skill_catalog.py skill_catalogs/document.json \
  --source chat=/release/chat-skills \
  --source native=/release/native-skills \
  --output-dir /release/document-skill-zips
```

The packager validates all packages locally before writing ZIPs to a new output
directory. It needs no Backend connection or database configuration.

Administrators upload each ZIP through the existing Skill management UI.
Use `POST /api/v1/kinds/skills/public/upload` for a new public Skill and select
the required marketplace tags. Update an existing ID with
`PUT /api/v1/kinds/skills/public/{skill_id}/upload`. Keep the original ZIP
used for the previous release and upload it to restore that version. Use the
original release archive because the download may have its MCP declarations
removed.

Skill publication and binding changes are separate operations. Existing Chat
bindings keep the same `document` ID. Enable the formats you need through
the normal Skill settings for ClaudeCode or Codex. If a native agent, template,
or default Skill explicitly preloads `document`, replace it with the needed
formats through its management UI before updating `document` to the Chat-only
version. Existing user and group settings retain their enabled state,
exceptions, and preload choices. Uploading an archive does not migrate bindings.

Focused tests verify archive metadata, complete resources, and reproducible ZIPs.
The existing `claude-runtime` desktop checkpoint uploads two versions of
ordinary format Skills through the standard APIs and verifies that overlapping
executions in a shared Home read the correct versions and resources.
