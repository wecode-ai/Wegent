# Prompt Library

A focused Composer extension inspired by snippet managers and AI prompt tools.

After installation and a Core DSH restart:

- Open **Prompt Library** from the Wework sidebar.
- Type `/review`, `/plan`, or `/explain` in the Composer.
- Type `@prompt` to insert a stable prompt-library reference.

The slash command receives the public `invocation.composer` API and inserts its
template into the active draft. No Wework-private module is imported.
