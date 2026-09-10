---
sidebar_position: 5
---

# Marketplace UI Guidelines

The marketplace follows the complete Wework design contract in
[`wework/DESIGN.md`](../../wework/DESIGN.md). This document only defines
marketplace-specific behavior.

These interactions are implemented and covered by focused UI/Electron
verification. They may be exercised locally, but must not be presented as
production publication until the external GitLab, native-runner, HTTPS, and
release-credential gates in [Operations](./OPERATIONS.md) pass.

## Information architecture

The plugin workspace has two primary views:

- **Marketplace** for discovery, source selection, search, filtering, and
  installation.
- **Installed** for enablement, component settings, updates, sharing, and
  removal.

Plugin details should expose identity, provenance, version, included
capabilities, authorization requirements, and a clear primary action. Do not
repeat the same metadata in multiple panels.

The publication redesign does not replace the current detail page. Preserve
**Chat now**, trial tasks, version/update information, application authorization,
included capabilities, and the owner-only actions to continue editing, uninstall,
or delete. Enterprise consumers see installation/authorization controls but not
personal-source edit, share, or delete actions.

## Marketplace sources

Cloud and local marketplaces can appear together. Source tabs must have stable
identities and preserve the user's selection. A failed source must show its own
error without hiding healthy sources.

Plugin identity is `<plugin-name>@<marketplace>`. Never merge entries by display
name or plugin name alone. A local Wegent materialization may be deduplicated
against its cloud record; an OpenAI or user-added marketplace entry with the
same name remains distinct.

User-added sources must display their repository or configured marketplace name.
Built-in source labels must use localized strings, not persisted display text as
state.

## Catalog behavior

- Preserve useful results during refresh.
- Search names, descriptions, source labels, and capabilities.
- Keep installation and update states visible without relying on color alone.
- Disable duplicate actions while a request is pending.
- Explain whether an action affects the account, the current device, or all
  registered devices.
- Keep local marketplace browsing available when the cloud is disconnected.

## Installation and authorization

Installation is complete only after the current device confirms
materialization. Show pending and failed device states explicitly.

If a connector requires authentication, present the appropriate browser or QR
flow before installation or use. Credentials remain in the device credential
store. Cancellation and failure must leave the plugin in a recoverable state.

## Sharing and publishing

Use a compact secondary **Share** button with an icon and label on personal-plugin
details. Do not label that entry **Publish** or **Share & publish**: the user is
choosing an intent, and only one choice begins a publication request. The scope
dialog opened by **Share** is titled **Share & publish**, because it contains both
personal sharing and enterprise publication intents.

The first surface contains exactly two choices:

- **Specific members or departments** — opens the existing member/department
  picker and applies the ACL after package scanning. The organization root is a
  department option, not a third scope. The picker explicitly requests it with
  `include_organization=true`; absence of that option must not be inferred as an
  empty ACL.
- **Everyone in the enterprise** — clearly says that this submits an application
  and is not immediately visible to everyone.

Do not expose `public` to ordinary authors. It is an official-catalog scope. The
GitHub-based Wework official-public flow remains a P1 product decision, so this
enterprise interaction must not invent or imply a finalized GitHub submission UI.

Opening this surface is a readiness boundary. Fetch the latest personal ACL and
the complete publication-request state together, and do not mount an actionable
dialog until both succeed. If either request fails, keep the dialog closed and
show a retryable error so a stale local cache cannot overwrite recipients or
start a duplicate enterprise request.

### Enterprise application drawer

Keep the user on the existing detail page and use a right-side drawer for the
three-step form:

1. **Version** shows the current packageable personal version and collects
   release notes, required after trimming and limited to `2000` characters. It
   does not upload, scan, or freeze a server snapshot.
2. **Permissions and risk** asks the author to declare external domains,
   commands, local-file access, credentials, application authorization, and test
   notes, required after trimming and limited to `1000` characters. Do not prefill
   findings from a package that has not yet been submitted.
3. **Confirm** summarizes all declarations. Final submission uploads the package,
   creates the immutable revision, records server-computed SHA-256 values, and
   explains that later edits to the personal source do not affect this revision.

After submission, the detail page remains usable. The owner can chat, run trial
tasks, continue editing, and update selected recipients. A status card shows the
submitted version separately from the current personal version. Automated checks
begin after submission and must complete before administrator review.

### Progress and revision behavior

Use the same five stages everywhere:

1. Submit request
2. Automated checks
3. Administrator review
4. Code review
5. Release

Stage labels must not imply that administrator acceptance publishes a plugin.
After acceptance, show the MR and GitLab checks. Use child status text for
`changes requested`, `CI failed`, `waiting for merge`, `publishing`,
`publish failed`, and `withdrawn` without changing the canonical stage names.

Before merge, expose **Withdraw application** with its asynchronous cleanup state.
A returned request shows the administrator's required changes and starts a new
revision in the same Request on resubmission. A deterministic automated-check
failure follows the same immutable-revision rule. Upload, transport, and
infrastructure failures retry the original revision with the same logical attempt.
Never replace or visually rewrite the earlier revision.

Allow only one active Request for a personal source, even when its personal
version changes. Keep all Requests for the personal source, not just one row keyed
by plugin ID. Show the active Request first, preserve the latest published
enterprise link, and let the owner switch across historical Requests and
immutable revisions to inspect checks, evidence, events, and GitLab facts. After
a Published Request is terminal, applying with a higher personal version creates
a new Request starting at revision 1.

After `code_changes_requested`, show that a developer is updating the current
MR. Do not offer a non-technical author **Create new revision** for that
state. A new revision is reserved for administrator return or deterministic
automated-check failure before GitLab code review.

If the owner deletes the personal source before merge, the confirmation flow
first withdraws the request and closes or cancels any MR; deletion is
blocked if cleanup fails. After merge, deletion affects only the personal source
and never removes the enterprise edition or historical publication evidence.

### Web administrator experience

Submission and review management belongs to the Web administrator surface, not
the Wework desktop client. The queue supports status, risk, submitter, and text
filters, URL-synchronized filter state, pending-oldest-first ordering, revision,
waiting time, and GitLab status. The detail view displays the immutable revision,
manifest/package summary, declarations, stable scan findings with evidence,
acknowledgements, timeline, and GitLab state. Reviewers can switch revisions
without losing the request-level audit trail.

Render return requirements only from the dedicated `requiredChanges` response
field, which is shared with the requester view. Do not depend on or display an
arbitrary event payload.

The two primary decisions are:

- **Return for changes**, requiring actionable reasons;
- **Accept and create MR**, enabled only for the current revision with no
  blockers and required warnings acknowledged.

The acceptance confirmation must state that it creates a MR and does not
publish to the enterprise catalog.

### Identity and ownership

Keep the personal source and enterprise copy visually distinct. The personal
detail remains under personal creation and displays owner/share controls. The
published copy displays an enterprise source badge and **Everyone in the
enterprise**, with no edit/share/delete-source controls. It is valid for personal
v1.3.0 and enterprise v1.2.0 to coexist.

Do not infer permission from labels or hide backend authorization errors.
Revoked recipients must lose access immediately even when device cleanup is
pending.

## Accessibility and localization

- All interactive controls require descriptive `data-testid` values.
- Source tabs, dialogs, menus, and plugin rows must support keyboard navigation.
- Focus must be visible and restored after dialogs close.
- All user-visible copy must exist in both Wework locale files.
- Test long English and Chinese labels at desktop and mobile widths.
- Use status text or icons in addition to color.
- Move keyboard focus into the application drawer, preserve step state on
  validation errors, and restore focus to **Share** when the drawer closes.
- Risk findings must expose severity and evidence to assistive technology; color
  alone cannot distinguish `pass`, `confirm`, and `block`.

## Verification

Run focused unit tests, TypeScript checks, formatting, and linting. Changes to
desktop behavior or Electron integration also require the isolated real-Electron
workflow documented in `wework/AGENTS.md`.

Verify the whole sequence at real desktop dimensions: personal detail → Share →
selected-recipient picker or three-step application → progress/revision states →
Web administrator return/accept → MR/checks → enterprise consumer detail.
The sequence must preserve all existing detail-page actions not restricted by
source ownership.
