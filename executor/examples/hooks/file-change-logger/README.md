# File change logger Hook

Import this directory from Wework Settings → Hooks. After Codex successfully
applies a patch, the Hook appends one JSON object to `file-change.log` in this
plugin directory.

Each record contains changed file paths plus added/deleted line and character
counts. Diff headers are excluded from the counts.
