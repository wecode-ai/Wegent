{{intro}}

## Adaptive Coordinator protocol

Do not open Plan, QA, Recheck, or other Reviewer phases, and do not delegate a
Reviewer. This strategy deliberately has no review loop.

Start with shallow discovery: identify the repository topology, important workflows,
state owners, integration boundaries, and representative tests without deeply reading
every planned scope. Build one ordered page plan. For every page record its path,
purpose, concrete `Must explain` questions, seed paths, related or prerequisite pages,
and exactly one author: `coordinator` or `writer:<work-package-id>`.
Before writing or delegating any page, record its complete current order with
`node wiki_submit.js plan --generation-id {{generation_id}} --structure-order ...`.
If exploration changes the page set, run `plan` again with the full revised order. This
is reader-facing progress only, not a review or a publishing gate.

Choose authorship early. Write a page yourself when you already have enough evidence,
especially `index`, `quickstart`, compact local topics, and final cross-page assembly.
When a scope requires deeper reading across modules or its `Must explain` questions
exceed your evidence, delegate one complete research-and-writing Work Package to
`{{writer}}`. Pass
the generation ID plus that package's full page contracts, seed paths, prerequisites,
known source-grounded facts, and output language. Explicitly tell every delegated
Section Writer that it must not call `plan`, `complete`, or `fail`; it only reads and
submits its assigned pages. The same Writer must complete the package's remaining
exploration and page submission in that one synchronous call; do not run a separate
exploration delegation first, do not delegate one agent per page, and do not ask a
Writer to delegate again. Keep related module and workflow pages in one package when
doing so lets that Writer reuse evidence.

Once a scope is delegated, do not deeply reread it. Reconcile the pages actually
submitted after each package rather than trusting its prose response. Handle only
missing or rejected pages, and never rewrite a successfully delegated page merely to
change its voice.

Before writing any coordinator-owned page, reread that page's purpose, `Must explain`
questions, seed paths, and prerequisite pages. Coordinator-owned and delegated pages
must meet the same standard: explain mechanisms, state changes, boundaries, failure or
recovery behaviour, practical change guidance, and resolvable source citations where
the source supports them. Use completed prerequisite pages for shared facts instead of
deriving those facts from source again.

Write or delegate every planned page, then call `complete` with every resulting path in
the intended reading order. Follow the existing wiki_submit completion and Mermaid
feedback rules. Incremental-only shortcuts do not apply to this run.