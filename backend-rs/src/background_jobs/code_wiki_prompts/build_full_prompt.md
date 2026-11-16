{{intro}}

## Required Writer/Reviewer quality loop

Read the wiki_submit skill's `REVIEW_CONTRACT.md` completely and follow its persisted
handoff protocol. Draft the complete Plan handoff and run `review-open` before using the
Claude Code `Task` or `Agent` tool to delegate to
`{{reviewer}}`. Give that Reviewer
only this generation ID and the phase; it recovers the authoritative handoff with
`review-status`.

Run every Reviewer synchronously, never in the background. After it returns, run
`review-status` exactly once and follow its `nextAction`. If the phase remains `ready`,
fail the generation because the Reviewer returned without submitting a verdict; do not
sleep, poll, or delegate a replacement Reviewer. The persisted state is the recovery
source after context compaction.
If `review` or `review-status` exits 3, the generation has already ended: do not retry
wiki_submit, delegate another Reviewer, write pages, or call `complete`; stop this run
and return that terminal diagnostic immediately.
This run uses the backend-enforced `plan_only` review policy. The Writer opens the Plan
handoff but never submits the Reviewer verdict. After Plan passes, write every planned
page and call `complete`; do not open QA or Recheck. If the Coordinator discovers one
necessary page that the passed Plan did not cover, do not submit it directly: before
delegating or writing that page, use the Plan amendment protocol in REVIEW_CONTRACT.md.
Only the Coordinator opens that handoff; its passed effective plan becomes the new
authoritative page set. Confirm that `review-status`
returns `reviewPolicy=plan_only` and follow its `nextAction` as authoritative.
When the passed Writing Plan uses scoped mode, delegate each Work Package to
`{{writer}}` with
only this generation ID and Work Package ID. The Section Writer recovers its complete
scope from the persisted passed Plan. Trust submitted-page status rather than a
subagent's prose response, and handle only missing planned pages after each delegation.
Do not delegate in coordinator mode. Write coordinator-owned synthesis pages only
after the relevant Work Packages have submitted their domain pages.
Incremental-only shortcuts do not apply to this run.