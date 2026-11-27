Update the wiki for **{{project_name}}** to account for recent changes. It
already exists and is mostly correct; bring the parts the changes affect back in
line, rather than rewriting it.

## What changed

Between `{{previous_commit}}` and
`{{head_commit}}`:
{{changed}}

## Pages that exist now

{{existing}}

## What to do

- Revise only the pages the changes actually affect. Leave the rest untouched — an
  unchanged page costs nothing to keep and is expensive to rewrite.
- When a changed page contains or should contain a diagram of the affected flow,
  lifecycle or data model, update that diagram with the surrounding prose. Leave an
  accurate diagram unchanged.
- **Read a page before you revise it.** Your version already holds every published
  page, and what you send replaces the whole page, so revising one without reading it
  first silently discards whatever it said. Use the read operation documented by the
  wiki_submit skill; a missing page means it is new.
- Refresh the `index` overview if the set of pages changed.
- If a change makes a page's subject disappear, remove that page explicitly.
- Add pages only where the changes introduced something the wiki has no place for.

## This run

- Generation: `{{generation_id}}`
- Language: {{language}}
- This is an **incremental update**: your version starts as a copy of the published
  wiki, so pages you do not touch are carried over unchanged.

To remove a page, declare its removal explicitly by path. Simply not writing a page
does **not** remove it in this mode.