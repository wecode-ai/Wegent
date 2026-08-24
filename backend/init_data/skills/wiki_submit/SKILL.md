---
description: "Submit wiki documentation pages to Wegent backend API. Simplifies the HTTP POST process for wiki content submission."
version: "1.5.0"
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

A section that holds pages needs a substantive page of its own. If you submit
`architecture/backend`, also submit `architecture` with an overview of that section;
for `architecture/backend/api`, submit both `architecture` and `architecture/backend`.
This is a publish requirement: `complete` refuses a version with any ancestor path
that is not a page. Submit overview pages first where practical, and always before
running `complete`. Write `index` as the wiki overview.

Create a slash-separated section only when its parent has a meaningful overview **and**
at least two independent child pages. If one topic is all that is needed, make it one
page (for example `domain-concepts`) rather than a parent page plus a one-page folder.
Titles name the subject and the reader's purpose; do not use generic titles such as
"Domain concepts part", "Module part", "Part N", or their translated equivalents.

Link to another wiki page by its complete page path without an extension, for example
`[Backend](architecture/backend)`. Do not use `./architecture/backend.md` or a URL: wiki
pages are not files served at those locations.

Anything submitted is part of the version; there is no scratch page or draft namespace.
Remove an accidental page before completing the run.

## Generation workflow

### Before the first submit

1. Read the run prompt and make one page-and-link plan, including stable paths and a
   reading order.
2. In an incremental run, use `read` before replacing an existing page. A `submit`
   always replaces the complete page; it is not a patch.
3. Choose stable paths before writing. If a path has descendants, submit its substantive
   parent page as well.
4. Before submitting a page that contains a Mermaid fence, run `validate-mermaid` on
   the same Markdown file. Correct every reported block before submitting it.

### Before ending the run

1. Submit every planned finished page, and explicitly remove only pages whose subject
   disappeared in an incremental run.
2. Re-run `validate-mermaid` for every page whose diagram changed after its last
   validation. It uses the pinned Mermaid parser plus a matching guard for the known
   subgraph/node layout cycle, and gives a block line number plus an actionable
   correction error.
3. Run `complete` with the documented commit and an order that starts with `index` and
   follows the planned reading route.
4. Read the response. If publication is refused, restore the missing coverage — in
   particular, create every named section overview page — and run `complete` again.
   For every Mermaid diagram, keep node IDs distinct from subgraph IDs (for example
   `rpc_service` inside `rpc_group`), and correct every named diagram error before
   running `complete` again. The publish gate is authoritative: do not mark the run
   failed merely because it asks for a diagram correction.

Do not report the generation as complete until the response says it was published, or
use `fail` with an accurate error when the run cannot continue.

## Usage

### Submit a page from a markdown file

```bash
node wiki_submit.js submit \
  --generation-id 123 \
  --path architecture/backend \
  --title "Backend Architecture" \
  --file /path/to/page.md
```

### Validate Mermaid before submitting or completing

Run this command for every page containing a Mermaid fence before its first `submit`,
then again after changing any diagram and before `complete`. It has no API or token
requirements, so it can be run while drafting a local Markdown file.

```bash
node wiki_submit.js validate-mermaid --file /path/to/page.md
```

It exits nonzero and names each failing fence's opening line. Rewrite the listed
diagram, rerun the command, and submit only after it passes. A missing Mermaid parser
dependency exits with code 2: report that executor-image problem accurately instead of
claiming the page passed validation. The backend publish gate remains authoritative and
is the final protection before publication.

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

The response refuses publication when it finds a Mermaid diagram that cannot render.
Rewrite the named pages at the same paths and run `complete` again; readers continue
to see the prior published version until the corrected one passes.

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
