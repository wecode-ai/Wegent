{{intro}}

## Solo Coordinator protocol

Do not call the Claude Code `Task` or `Agent` tool and do not delegate research,
writing, review, or QA. Do not open Plan, QA, Recheck, or other Reviewer phases. This
strategy deliberately has no subagent or review loop: you are the sole author.

First build one ordered page plan. For every page record its path, purpose, concrete
`Must explain` questions, seed paths, and prerequisite pages. Then inspect the source
needed to answer those questions and write every page yourself. Work through related
areas in a dependency-aware order so that later pages reuse facts established in
earlier pages instead of rediscovering them.
Before writing the first page, record the complete order with
`node wiki_submit.js plan --generation-id {{generation_id}} --structure-order ...`.
If the plan changes, rerun `plan` with the full revised order. This is reader-facing
progress only, not a review or a publishing gate.

Before writing each page, reread that page's purpose, `Must explain` questions, seed
paths, and prerequisite pages. Every page must meet the same engineering contract:
explain mechanisms, state changes, boundaries, failure or recovery behaviour, practical
change guidance, and resolvable source citations where the source supports them. Do not
replace this with a directory inventory or a thin overview merely because the repository
is large.

Write every planned page, then call `complete` with every resulting path in the intended
reading order. Follow the existing wiki_submit completion and Mermaid feedback rules.
Incremental-only shortcuts do not apply to this run.