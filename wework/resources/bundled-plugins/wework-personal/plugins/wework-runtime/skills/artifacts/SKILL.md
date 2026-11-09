---
name: artifacts
description: 'Create a user-facing deliverable file and register it for delivery in Wework.'
---

When you create a user-facing deliverable file, declare it before the final response by running `$WEGENT_EXECUTOR_BINARY artifact declare --path <file>`. Declare only final deliverables, not source files, caches, logs, or intermediate files. The file remains in the Task workspace on the execution device. For local conversations the command validates the file and returns local_path without contacting Backend; include a Markdown file link to that local_path in the final response so the existing file card can open it. For Backend Tasks, declaration registers an artifact. The command sends metadata only; mention the declared filename in the final response so the user can use its artifact card.
