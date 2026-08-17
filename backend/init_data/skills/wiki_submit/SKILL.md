---
description: "Submit wiki documentation pages to Wegent backend API. Simplifies the HTTP POST process for wiki content submission."
version: "1.2.0"
author: "Wegent Team"
tags: ["wiki", "documentation", "api", "submission"]
bindShells: ["ClaudeCode"]
---

# Wiki Submit Skill

This skill provides a simple command-line tool to submit wiki documentation pages to the Wegent backend.

## Page paths

A page is identified by its `--path`: `index`, `architecture/backend`, `modules/indexing`.
Lowercase, `/`-separated, no file extension, at most 4 folders deep. Two paths may not
differ only by case — the projection matches them case-insensitively, so they would
collapse into one page.

**Keep a path stable across runs.** It is what lets an unchanged page keep its place,
its links and its search index. Changing it republishes the page as a deletion plus an
insertion, so reword titles freely and move paths rarely.

Send a page's **complete content** every time. There is no patch format; what you send
replaces the page.

A section that holds pages needs a page of its own. If you submit
`architecture/backend`, also submit `architecture` with an overview of that section.
Write `index` as the wiki overview.

Link to another wiki page by its complete page path without an extension, for example
`[Backend](architecture/backend)`. Do not use `./architecture/backend.md` or a URL: wiki
pages are not files served at those locations.

Anything submitted is part of the version; there is no scratch page or draft namespace.
Remove an accidental page before completing the run.

## Usage

### Submit a page from a markdown file

```bash
node wiki_submit.js submit \
  --generation-id 123 \
  --path architecture/backend \
  --title "Backend Architecture" \
  --file /path/to/page.md
```

### Submit page content directly

Note the `$'...'` quoting: in a plain double-quoted string `\n` stays a backslash and
an `n`, and the page arrives as one long line. For anything beyond a few lines, write
the markdown to a file and use `--file`.

```bash
node wiki_submit.js submit \
  --generation-id 123 \
  --path index \
  --title "Overview" \
  --content $'# Overview\n\nYour markdown content here...'
```

### Read what a page currently says

Only your own generation is readable, which in an incremental run is a complete copy
of the published wiki — so this is how you see a page before revising it.

```bash
node wiki_submit.js read --generation-id 123 --path architecture/backend > current.md
```

Exits 0 with no output when the page does not exist yet. In an incremental run that
means the page is new.

### Remove pages that no longer have a subject

Only meaningful in an incremental run, where your version starts as a copy of the
published wiki and not writing a page therefore does *not* remove it.

```bash
node wiki_submit.js remove \
  --generation-id 123 \
  --path modules/legacy-sync \
  --path guides/old-setup
```

### Complete the wiki generation

Report the commit you documented, so the next run knows what has already been covered.

```bash
node wiki_submit.js complete \
  --generation-id 123 \
  --head-commit "$(git rev-parse HEAD)" \
  --structure-order index,quickstart,architecture,modules
```

`--structure-order` controls the order readers see. Put `index` first and arrange the
remaining paths so the wiki reads from overview to detail. Unlisted paths are appended.

The response says whether the version was published. A completed version can still be
refused when it is unexpectedly smaller than the published wiki. If publication is
refused, write the missing pages and run `complete` again.

The response may also report Mermaid diagrams that do not render after a successful
publication. Rewrite the named pages at the same paths and run `complete` again so the
corrected version is republished.

### Mark generation as failed

```bash
node wiki_submit.js fail \
  --generation-id 123 \
  --error-message "Failed to analyze repository structure"
```

## Section types

`--type` defaults to `chapter` and can be left out. The legacy wiki used it to group
pages; a code wiki organises them by path instead.

Accepted values: `overview`, `architecture`, `module`, `api`, `guide`, `deep`, `chapter`.

## Authentication

The authorization token is **automatically obtained** from the `TASK_INFO.auth_token` environment variable when running inside an executor container. You don't need to specify it manually.

## Environment Variables

The following environment variables are automatically available in executor containers:

- `TASK_API_DOMAIN`: Backend API domain (e.g., `http://wegent-backend:8000`). The endpoint is automatically built as `{TASK_API_DOMAIN}/api/internal/wiki/generations/contents`
- `TASK_INFO`: Contains `auth_token` for API authentication

Optional override:
- `WIKI_ENDPOINT`: Full API endpoint URL (overrides auto-built endpoint from TASK_API_DOMAIN)
