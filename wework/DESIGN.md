# Wework UI and interaction design specification

This document is the durable design contract for the Wework application. It is
written primarily for AI contributors and applies to every UI or interaction
change under `wework/`.

Feature specifications may add requirements for a specific flow, but they must
not silently override this document. If a product requirement needs an
exception, document the reason in the feature specification and update this
document when the exception establishes a reusable pattern.

The keywords **must**, **should**, and **may** are intentional. **Must** is a
requirement for new or changed UI. **Should** is the default and needs a written
reason to deviate. **May** is optional. Existing code that differs from this
document is migration debt, not a precedent to copy and not a request for an
unrelated mass rewrite.

## 1. Sources of truth

Use the following order when making a design decision:

1. Accessibility, security, and native platform requirements.
2. `AGENTS.md` and this design specification.
3. Semantic tokens and shared component APIs in the Wework codebase.
4. An established Wework feature pattern that complies with the previous items.
5. A new local pattern, only when the previous sources cannot express the
   requirement.

Before adding a component, search `src/components/ui/`,
`src/components/common/`, and the relevant feature directory. Improve a shared
component when the behavior is reusable. Do not create a visually similar
one-off implementation because it is faster locally.

When an existing shared component conflicts with this specification, fix the
shared component if that is safely in scope. Otherwise, avoid spreading the
conflict and record the follow-up. A feature-local exception must not become an
informal second design system.

## 2. Product character

Wework is a focused desktop workbench for long-running AI and coding tasks. Its
interface should feel calm, compact, dependable, and native to the current
platform.

- Keep the task, conversation, or workspace content visually dominant.
- Prefer a small number of clear actions over dense groups of equal-weight
  controls.
- Use progressive disclosure for secondary settings and infrequent actions.
- Preserve the user's context during loading, reconnecting, pane changes, and
  recoverable failures.
- Make system state visible. Never make an unavailable or delayed action look
  successful.
- Familiar behavior is more important than decorative novelty.

## 3. Responsive modes

Wework has three layout ranges:

| Mode    | Width          | Design expectation                                   |
| ------- | -------------- | ---------------------------------------------------- |
| Mobile  | `<=767px`      | Touch-first, one primary surface at a time           |
| Tablet  | `768px–1023px` | Responsive composition based on available space      |
| Desktop | `>=1024px`     | Pointer and keyboard workbench with persistent panes |

Use responsive styling when only size or arrangement changes. Split mobile and
desktop components when navigation, information priority, or interaction
behavior differs materially. Do not hide a desktop interaction on mobile
without providing an explicit mobile path to the same essential capability.

- Mobile interactive targets must be at least `44px × 44px`.
- Desktop workbench controls use `h-8`; icon-only controls use `h-8 w-8`.
- Standard toolbar icons use `h-4 w-4`; toolbar gaps use `gap-1` or `gap-1.5`.
- Do not introduce another control height inside a desktop toolbar without a
  documented usability reason.
- Test constrained widths and long translated text. Truncation must not remove
  the only way to identify or operate an item.

### 3.1 Layout grid and gutters

Use a 4px base grid. Align related text, controls, and panel edges; avoid optical
misalignment caused by individually centered elements.

| Context                            | Horizontal gutter | Typical section gap |
| ---------------------------------- | ----------------- | ------------------- |
| Mobile primary screen              | `16px`            | `24px`              |
| Mobile compact drawer or sheet     | `12px`            | `16px`              |
| Tablet page                        | `24px`            | `24px`              |
| Desktop settings or catalog page   | `24px`            | `32px`              |
| Desktop dense workbench pane       | `12px` or `16px`  | `16px`              |
| Dialog content                     | `24px`            | `20px`              |
| Compact popover or contextual menu | `8px` or `12px`   | `8px`               |

- Full-bleed workbench surfaces may reach the window edge; their content still
  needs an intentional internal gutter.
- Use resizable panes for user-owned workspace allocation. Persist the user's
  chosen size when the existing feature supports persistence.
- Set useful minimum pane sizes. Collapse or switch mode before content becomes
  unusable; do not squeeze controls into overlap.
- Reading-heavy content should normally stay within `680px–720px` or roughly
  60–75 characters per line. Data tables, terminals, diffs, and canvases may use
  the available width.
- A settings form should normally stay within `640px`; do not stretch short
  fields across a wide screen.
- Prefer spacing to dividers. Add a divider only when spacing alone does not make
  the grouping clear.

## 4. Visual system

### 4.1 Color and surfaces

Use semantic Tailwind colors backed by the CSS variables in
`src/styles/globals.css`:

- Backgrounds: `bg-base`, `bg-background`, `bg-surface`, `bg-popover`.
- Text: `text-text-primary`, `text-text-secondary`, `text-text-muted`.
- Structure: `border-border`, `bg-muted`.
- Brand and focus: `primary`, based on teal `#14B8A6` in the light theme.
- Workbench-specific surfaces: the semantic sidebar, code, reasoning, and
  mobile-drawer tokens.

Do not hardcode light-only colors in product UI. If no semantic token expresses
a reusable meaning, add a light and dark token instead of scattering literal
values. A one-off data visualization color may be literal when its meaning is
local and both themes have been verified.

The visual hierarchy is intentionally quiet:

- Use borders and surface changes before shadows.
- Reserve strong contrast for primary content and the current action.
- Do not use teal for large decorative areas or several competing actions.
- Status must not be communicated by color alone; pair it with text, an icon,
  shape, or accessible label.

### 4.2 Typography and content density

- Use `--font-ui` for interface text and `--font-code` for code, terminal
  content, paths when monospacing improves scanning, and keyboard input.
- Use the following type roles. Do not invent intermediate sizes for local
  visual tuning.

| Role                    | Size / line height | Weight         | Typical use                                  |
| ----------------------- | ------------------ | -------------- | -------------------------------------------- |
| Display                 | `28px / 36px`      | `600`          | Rare empty-state or onboarding headline      |
| Page title              | `20px / 28px`      | `600`          | Settings and top-level destination title     |
| Section title           | `16px / 24px`      | `600`          | Major content group                          |
| Body                    | `14px / 20px`      | `400`          | Default form, dialog, and reading text       |
| Body strong             | `14px / 20px`      | `500` or `600` | Emphasis and row title                       |
| Compact UI              | `13px / 18px`      | `400` or `500` | Desktop toolbar, sidebar, composer controls  |
| Caption                 | `12px / 16px`      | `400` or `500` | Metadata, helper text, timestamps            |
| Micro                   | `11px / 16px`      | `500`          | Dense badges only; never primary information |
| Mobile navigation label | `16px / 22px`      | `400` or `500` | Primary mobile rows and actions              |

- Default desktop UI is `13px` for dense workbench chrome and `14px` for forms
  and content. Default mobile UI is at least `16px` for primary labels and input
  text.
- Use no more than three type roles in one compact surface.
- Body copy is left aligned. Do not justify text.
- Use `400` for normal text, `500` for interactive labels and moderate emphasis,
  and `600` for headings. Avoid `700` unless a brand asset requires it.
- Prefer sentence case. Avoid all caps except for established technical terms.
- Keep labels concise, but do not replace an unfamiliar action with an
  unexplained icon.
- Use tabular or monospaced numbers only when values need columnar comparison or
  stable width.

### 4.3 Spacing scale

Use the shared 4px spacing ramp. Values of `2px`, `6px`, and `10px` are allowed
for optical alignment inside compact controls, not as the basis of page layout.

| Token intent | Value  | Typical use                                 |
| ------------ | ------ | ------------------------------------------- |
| Hairline     | `2px`  | Optical correction, badge inset             |
| XXS          | `4px`  | Icon-label gap, tightly related items       |
| XS           | `6px`  | Compact toolbar gap                         |
| SM           | `8px`  | Component internals, menu item grouping     |
| MD           | `12px` | Card internals, compact panel padding       |
| LG           | `16px` | Default content gutter and field separation |
| XL           | `20px` | Dialog groups                               |
| 2XL          | `24px` | Page groups and mobile gutter               |
| 3XL          | `32px` | Major page sections                         |
| 4XL          | `40px` | Large empty-state separation                |
| 5XL          | `48px` | Top-level page rhythm                       |
| 6XL          | `64px` | Rare hero or onboarding spacing             |

- Elements separated by `4px–8px` are perceived as one control or group.
- Use `12px–16px` between related groups and `24px–32px` between sections.
- Do not use margin to compensate for a component with incorrect internal
  alignment; correct the component.

### 4.4 Icons, shape, borders, and elevation

- Reuse the installed icon library and existing product symbols.
- Use `16px` icons for desktop controls, `20px` for standard mobile controls,
  and `24px` only for prominent navigation or illustrative actions. `12px` and
  `14px` icons are reserved for dense status metadata.
- Keep icon stroke weight consistent within one surface. Do not mix filled and
  outlined icons for decoration; a fill change may communicate selection.
- Icon-only controls require a localized accessible name and, when the action is
  not universally recognizable, a tooltip.
- Use this radius scale:

| Radius      | Use                                                         |
| ----------- | ----------------------------------------------------------- |
| `4px`       | Tiny badges and dense embedded elements                     |
| `6px`       | Compact desktop controls                                    |
| `8px`       | Default controls, menus, cards, and the global radius token |
| `12px`      | Prominent cards, popovers, and dialogs                      |
| `16px`      | Mobile cards, sheets, and large composer surfaces           |
| Full / pill | Avatars, status dots, segmented pills; not ordinary cards   |

- Borders are normally `1px`. A `2px` border is for focus or a selected state,
  not general decoration.
- Elevation level 0 uses only a surface or border. Level 1 is for menus and
  popovers. Level 2 is for dialogs and system-critical overlays. Do not stack
  multiple strong shadows.
- Use semantic z-index classes (`z-chrome`, `z-popover`, `z-modal`,
  `z-critical`, `z-system`, and `z-system-popover`). Do not solve stacking bugs
  with arbitrary large z-index values.

## 5. Components and states

Every interactive component must define the states that apply to it:

- default;
- hover for pointer input;
- active or pressed;
- keyboard focus;
- selected or current;
- disabled when the action cannot be requested;
- pending when the request has started;
- success, error, or unavailable when the result needs to remain visible.

Selection, focus, and hover are different states and must not be represented as
if they were interchangeable.

- Use the shared `Button` and common controls before styling raw elements.
- Dialog primary actions use `Button` with `variant="primary"`.
- Destructive actions must be visually and textually explicit. Use confirmation
  when the result is irreversible or difficult to recover; otherwise prefer an
  undo path.
- Do not enable duplicate submissions while an asynchronous action is pending.
- Do not replace the entire surface with a spinner when existing content can
  remain useful.
- Empty states explain what is empty and provide the next relevant action when
  one exists.
- Disabled controls that are not self-explanatory must expose the reason in
  nearby text or an accessible tooltip.

### 5.1 Component density and sizing

Choose a density by context, not by personal preference. Do not mix compact and
comfortable controls in one action group.

| Component                         | Desktop compact  | Desktop standard | Mobile              |
| --------------------------------- | ---------------- | ---------------- | ------------------- |
| Icon button hit area              | `32px`           | `36px`           | At least `44px`     |
| Text button height                | `32px`           | `36px` or `40px` | At least `44px`     |
| Text input, select, or combobox   | `32px` or `36px` | `40px`           | At least `44px`     |
| Menu or compact list row          | `32px`           | `36px` or `40px` | At least `44px`     |
| Standard list or settings row     | `40px`           | `44px`           | `48px` or taller    |
| Checkbox or radio visible control | `16px`           | `16px` or `20px` | `20px`, 44px target |

- The visible glyph may be smaller than the hit area.
- WCAG's `24px` minimum pointer target is the hard floor for exceptional dense
  desktop content. Wework's default remains `32px`; mobile remains `44px`.
- Preserve at least `4px` between adjacent compact targets and `8px` between
  unrelated actions.

### 5.2 Buttons and action hierarchy

- Use a button for an action and a link for navigation.
- Use at most one primary button in an action group or dialog. Secondary actions
  must have lower visual emphasis.
- The primary action label describes the result, such as "Create task" or
  "Delete file", rather than a vague "OK".
- Order dialog actions consistently: secondary or cancel first, primary last in
  left-to-right layouts. Follow native platform placement when the surface is a
  native system dialog.
- Icon-only buttons are for familiar, frequently used toolbar actions. Use a
  visible text label for consequential, unfamiliar, or low-frequency actions.
- A toggle button must communicate both current state and the action available.
  Use `aria-pressed` or the appropriate native state.
- Do not use a destructive style for ordinary cancellation. Red means the action
  itself destroys, removes, revokes, or permanently stops something.

### 5.3 Forms and validation

- Every field has a persistent label. Placeholder text may show an example, not
  repeat or replace the label.
- Required and optional status must be clear before submission. Prefer marking
  the less common case to reduce noise.
- Put helper text and errors directly below the field they describe. Keep space
  stable when a frequently changing validation message would otherwise shift the
  layout.
- Validate format after blur or after the user pauses, and validate completeness
  on submit. Do not show an error before the user has had a reasonable chance to
  enter a value.
- On submit failure, focus the first invalid field or an error summary that links
  to invalid fields. Preserve every valid value.
- Error text states the correction, not only the condition: "Enter a valid URL"
  is better than "Invalid input".
- Use a switch for a setting that applies immediately. Use a checkbox for a
  selection that is committed with other form values.
- Search fields may use a `150ms–300ms` debounce. A submitted command or message
  must not be debounced.

### 5.4 Lists, tables, trees, and tabs

- A whole row may be clickable only when it has one clear primary destination.
  Secondary row actions need separate targets and must not accidentally trigger
  the row.
- Keep column alignment stable while data loads or updates. Right-align numeric
  values that users compare; left-align names and natural-language values.
- Use a table when users compare values across rows and columns. Use a list when
  each item is read independently.
- Tables need a visible header. Sortable headers expose direction visually and
  semantically; sorting must not move keyboard focus unexpectedly.
- Trees use disclosure controls and predictable arrow-key behavior. Do not use
  indentation alone to communicate hierarchy.
- Tabs switch peer views without changing task context. The active tab is
  visually distinct and exposed with `aria-selected`; arrow keys move within the
  tab list.
- Virtualized collections must preserve keyboard navigation, accessible names,
  selection, and scroll position.

### 5.5 Cards, empty states, and progressive disclosure

- Use a card only when a boundary communicates grouping, selection, or an action.
  Do not put every section in a card.
- Avoid nesting more than two visible card levels.
- Empty states contain a concise explanation and one relevant next action. Do
  not show a large illustration in dense workbench panes.
- Advanced settings and infrequent metadata may be collapsed, but current
  status, errors, and required decisions must remain visible.

## 6. Interaction behavior

### 6.1 Feedback and asynchronous work

An interaction must acknowledge the user's input immediately. Match feedback to
the scope and duration of the operation:

- Use an inline state for a local field or component action.
- Use a transient notice for a completed, non-blocking result.
- Use a persistent banner or panel state when the user must act or the condition
  remains relevant.
- Use a modal only when the user must decide before continuing.
- Show determinate progress when meaningful progress data is available.

Avoid feedback flicker:

| Expected duration | Feedback                                                      |
| ----------------- | ------------------------------------------------------------- |
| Under `300ms`     | Usually no spinner; use pressed or pending button state       |
| `300ms–1s`        | Inline spinner or compact progress indicator                  |
| Over `1s`         | Skeleton for structural content or explicit progress status   |
| Long-running      | Persistent progress with task identity and safe backgrounding |

- A skeleton mirrors the stable structure of the final content. Do not create a
  detailed fake layout for unpredictable data.
- Transient success notices normally remain for about `4s`. Notices with an
  action need `6s–8s` or must remain until dismissed. Errors that require action
  remain visible.
- Keep the previous useful content visible during refresh. Distinguish initial
  load, refresh, pagination, and background synchronization.
- When a request can be canceled safely, expose cancel without misrepresenting
  cancellation as completed until the runtime confirms it.

Optimistic updates are allowed only when failure can be clearly reversed. On
failure, retain the user's input and context, explain what happened in actionable
language, and offer retry or recovery when possible.

Never silently convert a failed cloud or local-runtime operation into apparent
success. Offline and reconnecting states must distinguish unavailable cloud
capabilities from local capabilities that still work.

### 6.2 Navigation and context

- Back returns to the previous meaningful product context; close dismisses the
  current layer. Do not use the two labels interchangeably.
- Opening and closing sidebars, workspaces, previews, and settings should
  preserve the active task and unsent input unless the user explicitly discards
  them.
- Keep the primary task title and current selection visible where space allows.
- Avoid unexpected navigation after background updates.
- A new window, external application, or external URL must be clear before the
  user activates it.

### 6.3 Overlays, menus, and dialogs

- Use one overlay pattern for one interaction role: tooltip, menu, popover,
  dialog, or critical system layer.
- Escape closes the topmost dismissible layer.
- Clicking outside may close a lightweight menu or popover, but must not discard
  entered data without warning.
- Opening a dialog moves focus into it. Closing it restores focus to the trigger
  when the trigger still exists.
- Modal dialogs trap keyboard focus, expose an accessible name, and use
  `role="dialog"` with `aria-modal="true"` or an equivalent accessible primitive.
- Menus expose the correct expanded state and keyboard behavior. Do not model
  ordinary site navigation as an application menu without a reason.

Use these overlay defaults:

| Surface         | Size and placement                                                |
| --------------- | ----------------------------------------------------------------- |
| Tooltip         | `4px` from target; max width `320px`; plain supplemental text     |
| Menu            | `4px–8px` from trigger; minimum trigger width when appropriate    |
| Popover         | `8px` from trigger; `12px–16px` padding; viewport-safe max height |
| Small dialog    | About `400px`; confirmations and one-field tasks                  |
| Standard dialog | About `560px`; ordinary forms and choices                         |
| Large dialog    | Up to `720px`; use only when comparison or preview needs width    |

- Dialog width must not exceed the viewport minus `32px`. On mobile, use a
  bottom sheet for a short contextual task and a full-screen surface for a long
  or multi-step task.
- Dialog content scrolls independently when needed; the title and action row
  remain visible.
- Do not open a modal on top of another modal. Replace the modal content for a
  true next step or close the first layer before opening a separate task.
- Tooltips appear on hover and focus, usually after about `500ms`, and disappear
  on pointer exit, blur, or Escape. They never contain required actions or system
  feedback.
- Positioning must flip or shift at viewport edges instead of clipping content.

### 6.4 Keyboard, pointer, and touch

- Every essential action must be usable without a mouse.
- Use native elements whenever possible. Do not recreate button or link behavior
  with a generic element.
- Keep focus visible and predictable. Never remove the focus indicator without a
  semantic replacement.
- Enter submits a focused single-purpose form when expected. Escape cancels the
  current transient mode. Multiline composer behavior must preserve its
  documented send and newline shortcuts.
- Dragging must have an alternative for essential actions when a user cannot
  perform precise pointer movement.
- Hover-only content must also be reachable through focus or another explicit
  action. Essential information cannot exist only on hover.

## 7. Accessibility

Target WCAG 2.2 AA for application UI, while following native platform
accessibility conventions where they are stronger.

- Normal text and images of text must reach `4.5:1` contrast. Large text may use
  `3:1`. Meaningful icons, control boundaries, and state indicators must reach
  `3:1` against adjacent colors. Verify every interactive state in both themes.
- Keyboard focus must be visible and unobscured. The default authored focus ring
  is at least `2px` and has at least `3:1` change of contrast against its
  surroundings.
- Desktop pointer targets must meet WCAG 2.2's `24px` minimum except for its
  documented exceptions. Mobile Wework targets must be at least `44px`.
- Preserve a logical heading structure, reading order, and focus order.
- Associate inputs with visible labels or accessible names. Placeholder text is
  not a label.
- Announce relevant asynchronous status changes through appropriate live-region
  semantics without repeatedly interrupting the user.
- Decorative icons are hidden from assistive technology; meaningful icons have
  an accessible name or adjacent text.
- Respect `prefers-reduced-motion`. Motion must not be the only way to communicate
  a state change.
- At `200%` text zoom, larger system text, and with translated copy, content and
  essential actions must remain available without two-dimensional scrolling in
  ordinary forms and reading views. Complex tables, terminals, diagrams, and
  code editors may scroll in their natural direction.
- Status announcements use `role="status"` or a polite live region. Reserve
  assertive announcements for urgent conditions that genuinely require
  interruption.
- Authentication and permission flows must support paste and password managers.
  Do not require memory puzzles or block standard assistive input.

Accessibility is part of the component contract, not a verification-only step.

## 8. Motion

- Use motion to explain continuity, hierarchy, or system status.
- Prefer short color and opacity transitions for controls and restrained spatial
  transitions for panels.
- Avoid continuous animation except for an active process that benefits from
  visible status.
- Stop decorative animation when the element is not visible and disable or
  simplify it for reduced-motion users.
- Do not delay an action so an animation can finish.

Use the following duration bands:

| Motion                       | Duration      |
| ---------------------------- | ------------- |
| Press and immediate feedback | `80ms–100ms`  |
| Hover, focus, color change   | `120ms–150ms` |
| Tooltip, menu, popover       | `150ms–180ms` |
| Dialog enter or exit         | `180ms–240ms` |
| Pane or layout transition    | `200ms–240ms` |
| Deliberate status emphasis   | Up to `300ms` |

- Use a standard easing close to `cubic-bezier(0.2, 0, 0, 1)` for movement.
  Entering elements may decelerate; exiting elements accelerate and should be
  slightly faster than entry.
- Do not animate large top-level surfaces across the entire window. Prefer a
  quick fade for destination changes and a short transform for local panels.
- Staggering is allowed only when it explains order. Keep offsets under `40ms`
  and total motion under the duration band.
- Under reduced motion, remove nonessential transforms, parallax, shimmer, and
  looping animation. Preserve an immediate opacity or state change where needed.

## 9. Copy and localization

- All user-visible copy uses `@/hooks/useTranslation`.
- Add copy to both `src/i18n/locales/en/` and
  `src/i18n/locales/zh-CN/` in the appropriate namespace.
- Write labels as actions when they cause actions, and as nouns when they open a
  destination.
- Error messages state what failed and what the user can do next. Do not expose
  raw internal exceptions as the primary message.
- Confirmation text names the object and consequence. Avoid generic confirmations
  such as "Are you sure?" without context.
- Tooltips supplement labels; they are not a place for required instructions.
- Use one term for one concept. In English UI, use Agent for `Team` and Bot for
  `Bot`; in Chinese UI, use “智能体” and “机器人” respectively.
- Avoid ellipsis in labels unless it indicates that the action opens another
  step before taking effect. Use the single ellipsis character `…`, not three
  periods.
- Truncate only secondary or repeated context. Provide the full value through a
  tooltip, accessible name, detail surface, or copy action when users need it.

## 10. Desktop platform behavior

- Preserve native title-bar drag regions and window controls. Interactive
  elements must not accidentally become draggable.
- Platform-specific shortcuts use the platform's conventional modifier and are
  represented with the shared keyboard-shortcut component where visible.
- File paths, terminals, local applications, permissions, and external links
  must reflect the actual current environment.
- Respect macOS title-bar safe areas and traffic-light controls. Respect Windows
  window controls and system scaling. Do not simulate a platform control when a
  native capability already owns the behavior.
- Use `⌘` in visible macOS shortcuts and `Ctrl` on Windows and Linux. Shortcut
  handling must use the actual platform modifier rather than only changing the
  label.
- Do not drive or depend on a developer's personal Wework window when verifying
  behavior; use the isolated Tauri verification flow in `AGENTS.md`.

## 11. Testability and design verification

- Every new interactive element has a stable, descriptive `data-testid`.
- Preserve existing `data-testid` values unless the corresponding automated
  coverage changes in the same patch.
- Verify all affected states, not only the default screenshot.
- Verify light and dark themes when colors, surfaces, borders, elevation, or
  icons change.
- Verify keyboard operation and visible focus for new flows.
- Verify mobile and desktop when shared code or responsive behavior changes.
- Verify at minimum the narrowest supported width, a typical width, long Chinese
  and English content, `200%` text zoom, and reduced motion when the change can
  be affected by them.
- For a new or materially changed component, cover the applicable state matrix:
  default, hover, focus, active, selected, disabled, pending, success, and error.
- Use the real isolated Tauri application for final UI and interaction
  verification as required by `AGENTS.md`.

## 12. Design review checklist

Before handing off a UI change, confirm:

- The implementation reuses an existing pattern or explains why a new one is
  necessary.
- Visual values use semantic tokens and work in both themes.
- Default, hover, focus, disabled, pending, success, and error states that apply
  have been handled.
- Keyboard, pointer, touch, and reduced-motion behavior are appropriate to the
  target modes.
- Loading, empty, offline, permission, and failure paths preserve context and
  provide recovery.
- English and Chinese copy fit the layout and communicate the same intent.
- Stable test selectors and proportionate automated coverage exist.
- The relevant real-Tauri QA plan has been executed and evidence recorded.

## 13. Reference baseline

This specification combines common principles instead of visually copying one
vendor. When this document is silent, consult the current official guidance:

- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
  for Apple-platform behavior, accessibility, layout, and input conventions.
- [Material Design 3](https://m3.material.io/) for cross-device component,
  layout, color, type, and motion patterns.
- [Microsoft Fluent 2](https://fluent2.microsoft.design/) for desktop
  productivity density, spacing, controls, and inclusive interaction patterns.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) for normative web accessibility
  success criteria.
- [WAI-ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/) for
  accessible widget semantics, focus management, and keyboard interaction.

Platform guidance does not override Wework's product identity or create separate
visual systems per operating system. Adapt native behavior and input conventions
while preserving shared Wework tokens, information architecture, and component
meaning.
