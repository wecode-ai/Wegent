# Wework Codex UI design specification

This document is the durable visual and interaction contract for `wework/`. It
is written primarily for AI contributors. Wework's UI standard is the Codex
desktop UI standard: new and changed Wework surfaces must look and behave like
they belong to the same product family as the Codex desktop app.

The keywords **must**, **should**, and **may** are intentional. **Must** is a
requirement. **Should** is the default and needs a written reason to deviate.
**May** is optional. Existing Wework UI that differs from this document is
migration debt, not a precedent and not a request for an unrelated mass rewrite.

## 1. Source, scope, and update policy

This specification was extracted on 2026-07-16 from the local decoded Codex
desktop WebView bundle at `/Volumes/OuterHD/OuterIdeaProjects/decode-codex` and
calibrated against two user-supplied `3024px × 1794px` light-theme Codex desktop
captures: the new-task home and an active local conversation. Those captures
are the composition baseline; decoded CSS and components supply logical sizes
and responsive behavior that cannot be measured reliably from a scaled image.
The primary evidence was:

- `ref/webview/assets/app-DDJ4sa_V.css` for global tokens, typography, color,
  spacing, radii, elevation, and desktop overrides;
- `restored/ui/button.tsx`, `restored/ui/dropdown/`,
  `restored/ui/dialog-layout/`, `restored/ui/popover.tsx`, and
  `restored/ui/tooltip-b/` for shared component recipes;
- `restored/composer/composer.tsx` and its matching CSS chunk for the composer;
- `restored/app-shell/`, `restored/sidebar/`, and `restored/home/` for desktop
  shell, navigation, panes, tabs, and the home composition.

The decoded source is evidence, not a runtime dependency and not code to copy
verbatim. Do not import it, commit extracted OpenAI assets, or depend on its
hashed class names. Reproduce the rules through Wework semantic tokens and
shared components.

When Codex changes, update this document intentionally from a fresh audit. Do
not mix patterns from different Codex versions in one component. A current
user-supplied Codex screenshot outranks an older generalized conclusion in this
file. When a screenshot and decoded source appear to differ, reproduce the
screenshot's composition first and use source values for sizing, state, and
responsive behavior.

Use this decision order:

1. Accessibility, security, and native platform requirements.
2. This specification and `AGENTS.md`.
3. Wework semantic tokens and shared component APIs that comply with this file.
4. A verified Codex component recipe from the audited baseline.
5. A new local pattern only when the previous sources cannot express the need.

Codex is the visual and interaction baseline. WCAG and native platform rules
remain normative constraints; Apple HIG, Material, and Fluent are not alternate
visual directions for Wework.

## 2. Product character

The interface must feel like a focused desktop workbench: calm, precise,
compact, capable, and almost entirely neutral. Content and work state come
forward; application chrome recedes.

Codex's recognizable visual grammar is:

- grayscale surfaces and text establish nearly all hierarchy;
- blue is reserved for focus, links, and narrow accent or selection semantics;
- green is semantic success or addition, never product chrome or a primary CTA;
- compact controls sit in generous page composition; the home screen's single
  four-card quick-start row is intentional and must not expand into a dashboard;
- soft rounded shapes are systematic, not decorative;
- borders are low-contrast hairlines and elevation is restrained;
- one strong action is allowed; surrounding actions remain quiet;
- information appears progressively instead of every option being visible at
  equal weight.

A normal screenshot should first read as work content, then structure, then
controls. It must not first read as green, colorful, card-heavy, glossy, or
marketing-oriented.

### 2.1 Prohibited visual directions

Do not introduce:

- green or teal page backgrounds, sidebars, cards, composers, dialogs, banners,
  navigation selections, or default primary buttons;
- generic colorful feature tiles; the four Codex home quick-start cards and
  their blue, purple, green, and orange category icons are the explicit
  exception defined in section 5.4;
- a dashboard made from bordered cards when spacing and rows are sufficient;
- gradients, glows, glass effects, or illustrations without a functional reason;
- thick borders, dark outlines around ordinary controls, or several competing
  shadow strengths;
- oversized hero copy in workbench screens;
- arbitrary radii or making every shape a pill;
- saturated color as the main information hierarchy;
- multiple equally prominent CTAs in one action group.

## 3. Foundations

### 3.1 Base unit and spacing

Codex uses a `4px` base unit. Use multiples of 4 for layout. Values such as
`2px`, `5px`, `6px`, and `10px` are allowed only where the audited component
recipe uses them for hairlines, optical alignment, or compact internals.

| Value  | Codex-style use                                   |
| ------ | ------------------------------------------------- |
| `4px`  | tight icon/control gap, compact inset             |
| `6px`  | menu icon-label gap, attachment bottom inset      |
| `8px`  | row padding, control gap, compact surface padding |
| `10px` | sidebar row horizontal padding or radius          |
| `12px` | compact panel padding, composer input padding     |
| `16px` | ordinary group gap, conversation item gap         |
| `20px` | desktop page/panel gutter                         |
| `24px` | composer overhang, larger group separation        |
| `32px` | major section separation                          |

Rules:

- Prefer alignment and whitespace to dividers.
- Related controls normally use `4px–8px` gaps.
- Related groups normally use `12px–16px` gaps.
- Page-level content normally uses a `20px` desktop gutter.
- Do not repair a component's incorrect internals with arbitrary external
  margins; fix or reuse the shared component.

### 3.2 Typography

Use the Wework system UI stack (`--font-ui`) and the existing monospaced stack
(`--font-code`). The audited Codex UI uses the platform/system sans stack for
the general interface and a platform monospace stack for code. Do not copy or
bundle fonts from the decoded application.

The default Electron type ramp is the runtime result after Codex applies its
appearance settings. It supersedes the smaller pre-runtime values visible in
the static CSS bundle:

| Token/role     | Default size | Typical line height | Weight    | Use                                   |
| -------------- | -----------: | ------------------: | --------- | ------------------------------------- |
| `text-xs`      |       `12px` |              `16px` | `400–500` | shortcuts, timestamps, dense metadata |
| `text-sm`      |       `13px` |         `18px–19px` | `400–500` | helper text and compact controls      |
| `text-base`    |       `14px` |              `21px` | `400–500` | rows, menus, forms and ordinary body  |
| `text-lg`      |       `16px` |         `24px–25px` | `400–500` | emphasized UI                         |
| Heading small  |       `18px` |              `24px` | `500`     | section or dialog heading             |
| Heading medium |       `20px` |              `27px` | `500`     | page heading where needed             |
| Heading large  |       `24px` |              `29px` | `500`     | rare prominent heading                |
| Display        |       `28px` |         `32px–34px` | `500`     | exceptional home/onboarding use only  |

The default UI font size is `14px`; the default code font size is `12px`.
Appearance settings may change UI size from `11px` through `16px` and code size
from `8px` through `24px`, in whole-pixel steps. Changing UI size scales every
UI and heading token by `configuredSize / 14` and rounds each result to the
nearest pixel. Code size is independent and applies directly to code blocks,
diffs, editors, and terminals. The increase/decrease-font-size shortcuts step
both configured values together while respecting their separate limits. The
reset-font-size shortcut restores the default `14px` UI and `12px` code sizes.

Product code must consume the semantic Tailwind sizes, `heading-*` classes,
`text-chat`, `text-code`, or the corresponding CSS variables. Arbitrary font
utilities such as `text-[13px]`, literal `font-size` declarations, and literal
inline `fontSize` values are forbidden and checked by `pnpm lint`. A computed
font size is allowed only when it derives from the shared typography tokens,
such as an animated transition between two heading roles. Third-party content
that cannot inherit Wework variables requires a narrow documented exception.

The primary weight is regular. Codex uses subtle intermediate platform weights,
but Wework maps them to `400` for body and `500` for emphasis. Use `600`
sparingly and avoid `700` in product chrome.

Keep sentence case. Do not use uppercase labels for visual hierarchy. Use no
more than three type roles in a compact surface. Truncate repeated secondary
context only when the full value remains available through a tooltip, detail
view, accessible name, or copy action.

### 3.3 Icon scale

Use the established icon library and this Codex-derived scale:

| Token intent |   Size | Use                                  |
| ------------ | -----: | ------------------------------------ |
| 3XS          | `10px` | exceptional dense indicator          |
| XXS          | `12px` | spinner, micro status                |
| 2XS          | `14px` | compact trailing action              |
| XS           | `16px` | default desktop icon                 |
| SM           | `18px` | emphasized row icon                  |
| Base         | `20px` | larger control or mobile-adjacent UI |
| MD           | `24px` | prominent action or empty state      |
| LG           | `28px` | rare illustrative symbol             |

Icons are normally outline symbols with consistent stroke weight. Icon-only
controls must have a localized accessible name and a tooltip unless the action
is universally recognizable in context.

### 3.4 Radius and corner shape

Codex uses a deliberate radius ramp, with superellipse corners when the browser
supports them. Wework may use ordinary rounded corners until superellipse is
supported, but must preserve the component mapping.

| Radius | Component role                                           |
| ------ | -------------------------------------------------------- |
| `2px`  | tiny embedded marks                                      |
| `4px`  | compact internal element                                 |
| `6px`  | small control                                            |
| `8px`  | default control and inner tab surface                    |
| `10px` | sidebar/navigation row and tab container                 |
| `12px` | dropdown, popover, compact floating panel                |
| `16px` | prominent card when a true card boundary is needed       |
| `20px` | multiline composer and dialog                            |
| `24px` | exceptional large shell surface                          |
| Full   | text CTA, single-line composer, status/badge/avatar only |

Do not flatten everything to one global `8px` radius. Do not apply pills to
ordinary sidebar rows, menu items, cards, tabs, or multiline inputs. Pill text
buttons are allowed because they are an explicit Codex pattern.

### 3.5 Elevation and borders

Codex borders are derived from the current foreground instead of medium gray
outlines:

- light border: about `5%` foreground;
- default border: about `8%` foreground;
- heavy border: about `12%` foreground;
- focus border: blue at about `70%` opacity;
- overlay rings: usually a `0.5px` hairline.

Use a normal `1px` border only when the component recipe needs a visible
boundary. Do not outline every section.

The audited elevation recipes are intentionally light:

- `sm`: `0 1px 2px -1px rgb(0 0 0 / 8%)`;
- `md`: `0 2px 4px -1px rgb(0 0 0 / 8%)`;
- `lg`: `0 4px 8px -2px rgb(0 0 0 / 10%)`;
- `xl`: `0 8px 16px -4px rgb(0 0 0 / 12%)`;
- prominent surface: a `0.5px` stroke plus very soft `0 3px 7.5px / 4%` and
  `0 0 20px / 5%` shadows.

Ordinary page content has no shadow. Use elevation for composers, menus,
popovers, floating sidebars, and dialogs. Never reproduce the rejected Wework
composer shadow `0 18px 44px`; it is not the Codex recipe.

## 4. Color system

### 4.1 Neutral palette and surfaces

The Codex neutral reference palette is:

`#FFFFFF`, `#F9F9F9`, `#F3F3F3`, `#EDEDED`, `#AFAFAF`, `#5D5D5D`,
`#4F4F4F`, `#414141`, `#303030`, `#282828`, `#212121`, `#181818`,
and `#0D0D0D`.

Required semantic results:

| Role                 | Light                                 | Dark                                   |
| -------------------- | ------------------------------------- | -------------------------------------- |
| Main surface         | `#FFFFFF`                             | `#181818`                              |
| Surface under        | `#F9F9F9`                             | `#000000`                              |
| Editor/quiet surface | `#EDEDED` at about `40%`              | `#212121`                              |
| Elevated primary     | white at about `70%`, or opaque white | `#212121` at about `96%`, or `#282828` |
| Primary text         | `#1A1C1F`                             | `#FFFFFF`                              |
| Secondary text       | primary text at `70%`                 | primary text at `70%`                  |
| Tertiary text        | primary text at `50%`                 | primary text at `50%`                  |

These are reference values. Product code must consume semantic Wework tokens,
not scatter literals. Every reusable token must define both themes.

Surfaces should be separated in this order: spacing, a small neutral tone
change, a hairline, then elevation. Do not jump directly to a bordered card.

### 4.2 Accent and status colors

Codex's interactive accent is blue:

- focus/link blue: `#339CFF`;
- light accent surface: `#E5F3FF`;
- dark accent surface: `#00284D`.

Blue is for links, keyboard focus, selected emphasis, and narrow interactive
accents. It is not the default page background and is not normally the primary
button fill.

Green is semantic only:

- light success/addition: `#00A240`;
- dark success/addition: `#40C977`;
- success backgrounds are very low opacity, approximately `7%` light and `16%`
  dark.

Orange is warning/modified, red is error/destructive/deleted, and purple is
reserved for a feature with explicit semantic meaning. Status must always have
a non-color cue such as text, icon, shape, or accessible label.

### 4.3 Absolute green/teal restriction

Wework must not look green or teal. The current legacy Wework `primary` and
`hover` tokens are teal-based and therefore are not Codex visual tokens. Do not
use them for new or changed general UI until those tokens are deliberately
rebased.

Green/teal is allowed only for:

- confirmed success;
- added lines or resources;
- a small progress or status indicator whose meaning is also expressed another
  way;
- the `16px` green outline icon on Codex's home “审查代码并提出修改建议”
  quick-start card; this is a narrowly scoped baseline exception, not permission
  to color the card, label, hover state, or another feature green;
- an existing brand mark that cannot be changed.

Green/teal is forbidden for:

- page, pane, sidebar, title bar, drawer, modal, menu, popover, or card surfaces;
- composers, inputs, list rows, tabs, navigation selections, and empty states;
- default primary actions, ordinary hover, focus, or selection;
- decorative gradients, glows, illustrations, and feature icons.

In a normal screenshot, strong green/teal should occupy effectively `0%` unless
a success/addition state or the one home quick-start icon is visible, and less
than `5%` even then. If the first color impression is green, the screen fails
review.

### 4.4 Action colors

The primary action is an inverse neutral button:

- light theme: dark foreground-colored fill with a light label;
- dark theme: light foreground-colored fill with a dark label;
- hover: reduce the fill to approximately `80%` opacity;
- disabled: keep the same semantic treatment at approximately `40%` opacity.

Secondary actions use a foreground tint around `5%`; hover raises it to about
`10%`. Ghost actions are transparent and gain the neutral list-hover surface.
Danger actions use a low-opacity red surface with red text; reserve solid danger
for the final destructive confirmation when needed.

## 5. Layout and desktop shell

### 5.1 Main composition

- Desktop reading/conversation content has a normal maximum width of `48rem`
  (`768px`).
- Wide markdown blocks may extend to `56rem`; terminals, diffs, tables, and
  canvases may use their pane width.
- The desktop page gutter is normally `20px`.
- The home composer aligns to the same content column instead of floating at an
  unrelated width.
- Content may be full bleed only when the task requires a canvas, terminal,
  browser, diff, or similar work surface.

The home screen is not a card dashboard. It is one centered hero, one exact
four-card quick-start row, and one bottom composer. Do not replace the cards
with generic rows, add more card sections, or move the composer into the hero.

### 5.2 Toolbars, panes, and tabs

Codex desktop reference sizes:

- main toolbar/title area: `46px`;
- small title/menu toolbar: `36px`;
- pane toolbar: `40px`;
- sidebar navigation row: `30px`;
- app-shell tab: `28px` high;
- composer action button: `28px` high;
- collapsed/compact icon action: normally `28px` or the shared control size.

Use one height within an action group. A visible icon can remain `16px` inside
a larger hit area. Mobile targets remain at least `44px × 44px` even though the
desktop UI is denser.

Tabs are compact neutral containers: `28px` high, `10px` outer radius, `8px`
inner hover/active surface, `8px` horizontal padding, `8px` icon-label gap, and
`14px` text. Inactive text is secondary; active text is primary. Close controls
may reveal on hover/focus but must remain keyboard accessible.

### 5.3 Sidebar

- First-launch default width is `300px`, matching the decoded persisted default.
  Clamp resize to `240px–520px` and preserve the user's choice. The supplied
  `1512px × 897px` logical-size capture shows a resized width of about `275px`;
  screenshot-matched review artifacts must use that width.
- Sidebar rows are `30px` high with a `10px` radius, `8px–10px` horizontal
  padding, `14px` text, and an ordinary `16px` icon.
- Hover and active states use subtle neutral surface changes, not colored fills.
- Section spacing may be larger than row spacing; avoid divider-heavy grouping.
- On macOS light theme, use the captured warm translucent/off-white sidebar
  material and keep the main canvas pure white. Preserve the traffic-light safe
  area and Wework's four-item global top navigation, in order: sidebar toggle,
  Wework current-app entry, TODO/work-items entry, and application-list entry.
  Style those controls with Codex sizing and neutral states; never replace,
  reorder, or remove them merely to imitate Codex's Back and Forward controls.
- The sidebar content order is structural: product title and Search; primary
  destinations; pinned projects; projects; expandable tasks; and the account
  footer. Do not replace this with an app-switcher or a generic SaaS workspace
  navigation.
- Search has one visible sidebar entry: the icon beside the product title. Do
  not duplicate Search as a primary-navigation list row.
- Secondary row actions can appear on hover/focus but must not steal the row's
  primary click and must have a keyboard path.
- Collapse or float the sidebar before the main work area becomes unusable.

The audited shell changes behavior around `960px` and again around `720px`.
Wework may retain its established responsive breakpoints, but must switch
composition before panes overlap or primary content is squeezed below a useful
width.

### 5.4 New-task home baseline

The user-supplied Codex home capture is normative. Reproduce this composition:

- The main content and composer use the same `48rem` (`768px`) column plus the
  established composer overhang; they do not span the application viewport.
- The hero/suggestion block occupies the upper `39%` of the available home
  content height and aligns its contents to the bottom with `24px` bottom
  padding. This leaves deliberate empty space above and between the hero and
  composer.
- Center a quiet Codex/Wework mark above the heading. The heading is
  `28px/1.2`, weight `500`, centered, and uses the exact localized intent “我们
  该构建什么？”. Do not add a subtitle.
- Show exactly four root quick-start categories in a single row when space
  permits: explore, create, review, and fix. Use the exact product-equivalent
  labels and order.
- The grid uses `repeat(auto-fit, minmax(10rem, 1fr))` with a `12px` gap and a
  maximum of four visible root categories. Below `42.249rem`, hide item 4;
  below `31.499rem`, hide item 3; below `20.749rem`, hide item 2.
- Each card is at least `104px` high, has `16px` radius, `16px × 12px` padding,
  a white main surface, an Electron `0.5px` heavy-neutral ring, and the Codex
  medium-strong shadow. The icon sits at the top; the `14px/20px`, weight `500`
  label is anchored to the bottom. Do not add descriptions or arrow glyphs.
- The root icons use Codex's original SVG paths at a rendered `16px`. Their
  colors are, in order, blue `#0285FF`, purple `#924FF7`, green `#04B84C`, and
  orange `#FB6A22`. Only the icons use category color; card fill, border, label,
  focus, and hover remain semantic neutrals/blue focus. Do not substitute
  generic Lucide symbols when building this exact baseline.
- Root-card selection may drill down to Codex's compact suggestion list. It must
  not navigate away before the user selects a concrete prompt.
- Anchor the Composer toward the bottom of the main content, not immediately
  below the cards. On the home baseline, the project selector is a separate
  quiet rounded surface visually tucked behind the Composer; the input surface
  overlaps it and remains the foreground layer.

### 5.5 Active conversation baseline

The active-conversation capture is also normative:

- Keep the same sidebar and use a `46px` top title bar with the task title at
  the left, an adjacent overflow action, and panel/window controls at the right.
- The thread reads in a centered `48rem` column. Code blocks and user bubbles
  are neutral gray; inline code uses a slightly darker neutral chip. Links or
  code syntax may use restrained semantic accent colors.
- User messages are right-aligned compact neutral bubbles. Assistant content is
  left-aligned prose, not wrapped in a card. Turn metadata and feedback actions
  are quiet and subordinate.
- The bottom Composer shares the thread column and stays visible. It uses the
  same input hierarchy as home but without the home project-selector layer.
- When opening, closing, or resizing a side panel reflows conversation content,
  preserve the reader's visible message or content anchor. Continue following
  the bottom only when the reader was already at the bottom before the reflow.
- When the right work panel is open, render it as a floating `12px`-radius white
  panel near the top-right with a subtle ring and shadow. “输出” and “来源” are
  stacked sections separated by a quiet hairline, each with its own trailing add
  control. Do not turn it into a full-height colored inspector.

## 6. Component recipes

### 6.1 Buttons

Use the shared Wework `Button`; evolve it toward this contract instead of
styling new raw buttons independently.

Codex button rules:

- text buttons are normally pill-shaped;
- medium/toolbar rectangular controls use an `8px–10px` radius;
- icon buttons use an `8px` desktop radius in Electron, not necessarily a pill;
- default text size is `12px` for the smallest compact control and `14px` for
  ordinary controls;
- icon-label gap is `4px`;
- primary is inverse neutral, secondary is a `5%` neutral tint, ghost is
  transparent, and outline uses a quiet hairline;
- disabled opacity is `40%` and the cursor/state must clearly indicate
  unavailability;
- loading keeps the button width stable and replaces or precedes content with a
  `12px` spinner.

Use at most one primary action in a group. Use visible text for consequential,
unfamiliar, or low-frequency actions. Use red only when the action itself is
destructive.

### 6.2 Composer

The composer is the most prominent elevated control and must follow the Codex
recipe closely:

- align to the `48rem` content column;
- use the input/elevated neutral surface at about `90%` opacity, with a subtle
  backdrop blur only when platform rendering makes it useful;
- multiline composer radius is `20px`; a single-line composer may be a pill;
- use the prominent light elevation from section 3.5, not a large floating-card
  shadow;
- do not add a dark visible border in the normal state; forced-color mode may
  add an explicit outline;
- multiline input horizontal inset is `12px`;
- attachment inset is `8px`, with the nested radius derived from the outer
  composer radius rather than chosen independently;
- footer controls use compact `4px–8px` gaps and `28px` actions;
- on the home screen only, render the project selector as a separate background
  layer above the input surface, with the foreground Composer overlapping its
  lower edge; do not merge the selector into an internal top toolbar;
- the home placeholder is the short “随心输入”; the active-thread placeholder
  is contextual, such as “要求后续变更”. Do not add explanatory helper copy;
- the left footer begins with Add and the quiet “自定义” control; the right
  footer holds model/reasoning, microphone, and the circular submit control in
  that order. The submit control is neutral gray when unavailable and must not
  be green;
- collapse low-priority footer labels when the composer container is narrower
  than roughly `440px–475px`;
- drag state uses a subtle neutral overlay; blocked/submitting state dims and
  becomes inert without destroying entered content.

The Composer is not a green brand block, a thick outlined form, or a card with
an exaggerated shadow.

### 6.3 Navigation and list rows

- A compact navigation row follows the `30px` sidebar recipe.
- A standard selectable data row is at least `40px`, uses `12px` horizontal
  padding and an `8px` radius, and may use `12px` vertical padding when it has
  multiple lines.
- Use `14px` primary text and `12px–14px` secondary metadata.
- Selected and hover states use neutral surface changes. Blue may provide a
  narrow selected cue when needed.
- A whole row is clickable only when it has one clear primary destination.
- Enter and Space activate a custom row button; prefer native elements when
  possible.

### 6.4 Dropdowns and popovers

Dropdown and popover surfaces use:

- `12px` radius;
- `4px` internal surface padding;
- `0.5px` semantic ring;
- a lightly translucent elevated surface with subtle blur;
- restrained `lg`/`xl` elevation;
- `4px` default trigger offset and `6px–8px` viewport collision padding;
- maximum width and height constrained to the viewport minus `16px`.

Menu items use `14px` text, an `8px` radius, `8px–10px` horizontal padding,
`4px` vertical padding, a `6px` icon gap, and a neutral hover/focus surface.
Icons default to `16px` at `75%` opacity and become fully visible on hover or
focus. Disabled items use `50%` opacity and do not activate.

In the narrow environment popover, workspace and executor metadata form one
compact two-line item. Lead with a folder icon and the recognizable workspace
directory name. For local execution, show the executor name beside a laptop
icon; for cloud execution, show the device IP beside a cloud icon. Keep
execution-location and field labels available to assistive
technology and tooltips instead of repeating them visually. Keep the complete
workspace path available through the tooltip, accessible name, and copy action;
copy feedback must not change the row's geometry.

Use a menu for commands, a popover for a compact interactive surface, and a
dialog when a decision blocks continuation. Do not substitute one merely to get
a preferred shape.

### 6.5 Dialogs

Dialogs use:

- a centered elevated surface with `20px` radius;
- `0.5px` semantic ring, light `lg` shadow, and subtle translucent blur;
- a restrained scrim (`#00000022` in the audited Electron light treatment);
- a maximum width of `92vw`;
- default width `520px`;
- named widths `380`, `400`, `420`, `600`, `680`, and `800px` only when the
  content role warrants them;
- a close control at `16px` from the top/right using a `16px` icon;
- a stable header/content/footer structure with scrolling in the content region.

Opening moves focus into the dialog. Closing restores focus to the trigger when
it still exists. Escape closes the topmost dismissible dialog. Clicking outside
must not discard entered data without warning. Do not stack modal dialogs.

### 6.6 Tooltips

- Default delay is `700ms`; the warm handoff window between nearby tooltips is
  `300ms`.
- Use `14px` text, `8px` radius, a normal border, and `8px × 4px` padding.
- Default maximum width is `20rem` and the tooltip must flip/shift within `8px`
  of viewport edges.
- A tooltip supplements a control label; it never contains required actions,
  validation, or persistent system feedback.
- Open on keyboard focus as well as hover and dismiss on blur, pointer exit, or
  Escape.

### 6.7 Cards and empty states

Use a card only when a boundary communicates grouping, preview, selection, or a
single contained action. Prefer rows, whitespace, and a quiet surface. Do not
nest visible cards more than two levels.

Empty states are concise and task-oriented. They may use one quiet symbol and
one relevant action. Avoid generic colorful suggestion grids, large
illustrations, and marketing headlines. The exact four-card home quick-start
baseline in section 5.4 is not an empty-state anti-pattern and must not be
“simplified” into rows.

## 7. Interaction and state

Every interactive component must account for the applicable states:

- default;
- hover for pointer input;
- active/pressed;
- keyboard focus;
- selected/current;
- disabled;
- loading/pending;
- success, warning, error, or unavailable.

Hover, focus, and selection are distinct. Do not use the same styling and
semantics for all three.

- Acknowledge input immediately with pressed, pending, or local state.
- Keep useful content visible during refresh, reconnect, and long-running work.
- Prevent duplicate submissions while pending.
- Preserve unsent input and valid form values after recoverable failure.
- Never convert a failed cloud or local-runtime action into apparent success.
- Use optimistic updates only when failure is clearly reversible.
- Put status next to the affected object whenever possible; use a toast for a
  completed non-blocking result and a dialog only for a blocking decision.
- Secondary controls may reveal progressively, but current status, errors, and
  required decisions remain visible.

### 7.1 Forms

- Every field has an accessible name; ordinary settings fields also have a
  persistent visible label.
- Placeholder text is an example or prompt, not the only label.
- Helper and error text sit next to the field they describe.
- Validate format after blur or a reasonable pause; validate completeness on
  submit.
- Preserve valid values and focus the first invalid field or an error summary.
- A switch applies an immediate setting; a checkbox participates in a larger
  submitted selection.
- Enter submits a single-purpose form when expected. Multiline composer send and
  newline shortcuts must remain explicit and tested.

### 7.2 Navigation and context

- Back returns to the previous meaningful context; Close dismisses a layer.
- Opening or closing sidebars, previews, terminals, and settings preserves the
  active task and unsent composer input.
- Resizable panes keep useful minimum sizes and preserve user-owned allocation
  where the feature supports it.
- External URLs, applications, and windows must be clear before activation.
- Essential information and actions cannot exist only on hover.

## 8. Motion

Codex motion is short and functional:

- default CSS transitions: `150ms` with `cubic-bezier(0.4, 0, 0.2, 1)`;
- small opacity fades: `100ms–200ms`;
- sidebar/floating panel spring: about `200ms`, zero bounce;
- resizable/right panel spring: about `220ms`, zero bounce;
- dialog content height adjustment: `200ms ease-out`;
- deliberate composer footer entry may use a soft `350ms` spring with very low
  bounce when it explains continuity.

Use motion for continuity, hierarchy, or active status. Do not animate merely
to make a screen feel lively. Avoid large full-window slides, decorative loops,
parallax, and staggered card entrances. Respect `prefers-reduced-motion`; remove
nonessential transforms and set panel motion to immediate where appropriate.

## 9. Responsive behavior

Wework keeps its established product breakpoints:

| Mode    | Width          | Behavior                                                 |
| ------- | -------------- | -------------------------------------------------------- |
| Mobile  | `<=767px`      | touch-first, one primary surface at a time               |
| Tablet  | `768px–1023px` | collapse or overlay secondary panes as needed            |
| Desktop | `>=1024px`     | compact pointer/keyboard workbench with persistent panes |

Responsive behavior must preserve Codex's hierarchy and component grammar.
Change composition rather than proportionally shrinking desktop UI.

- Mobile interactive targets are at least `44px × 44px`.
- Desktop exceptional dense targets never fall below WCAG's `24px` floor.
- Collapse lower-priority labels before controls overlap.
- Switch panes to overlays or sequential views before the main content becomes
  unusable.
- Test long Chinese and English text, constrained height, system scaling, and
  `200%` text zoom.

## 10. Accessibility

Target WCAG 2.2 AA and native desktop accessibility conventions.

- Normal text reaches `4.5:1` contrast. Large text may use `3:1`.
- Meaningful icons, control boundaries, and state indicators reach `3:1` where
  the success criterion applies.
- Keyboard focus is visible and unobscured. Use the semantic blue focus token;
  do not substitute teal or remove focus without an equivalent indicator.
- Every essential action works without a mouse.
- Prefer native button, link, input, dialog, and menu semantics.
- Custom rows expose role, focusability, disabled state, and Enter/Space
  activation.
- Modal focus is trapped and restored correctly; menus and tabs implement their
  expected arrow-key behavior.
- Status changes use appropriate live-region semantics without repeated
  interruption.
- Color is never the only status cue.
- Decorative icons are hidden from assistive technology; meaningful icons have
  an accessible name or adjacent label.
- Authentication and permission flows support paste and password managers.

Accessibility overrides a visually exact Codex imitation when the audited
implementation and WCAG conflict.

## 11. Copy and localization

- All user-visible copy uses `@/hooks/useTranslation`.
- Add both English and Chinese strings in the appropriate namespace.
- Action labels describe the result: “Create task”, “Open folder”, “Delete
  file”, not vague “OK”.
- Errors state what failed and what the user can do next.
- Confirmation text names the object and consequence.
- Use one term per concept. English UI uses Agent for `Team` and Bot for `Bot`;
  Chinese UI uses “智能体” and “机器人”.
- Use the single ellipsis character `…` only when an action opens another step
  before taking effect.

## 12. Desktop platform behavior

- Preserve native title-bar drag regions and window controls; interactive
  elements are `no-drag` equivalents.
- Respect macOS traffic-light safe areas, Windows controls, system scaling, and
  actual platform shortcuts.
- Use the platform modifier in both behavior and visible shortcut labels.
- File paths, terminals, permissions, and external applications reflect the
  actual current environment.
- Keep pane resize and open/close motion stable under window zoom.
- Verify changes through the isolated real-Tauri flow in `AGENTS.md`, never a
  personal Wework window.

## 13. Implementation and review contract

Before adding a component, search `src/components/ui/`,
`src/components/common/`, and the feature directory. Improve a shared component
when the recipe is reusable. Do not create a second design system in feature
code.

Use semantic tokens. Literal values are allowed only when defining a token,
matching a verified one-off Codex recipe, or expressing local data
visualization semantics. Both themes must be verified.

Every new interactive element needs a stable, descriptive `data-testid`.
Preserve existing selectors unless their automated coverage changes in the same
patch.

For each material UI change, review:

- Does it look like Codex rather than a generic SaaS dashboard?
- Is the normal state grayscale and content-first?
- Is green/teal absent except for a real success/addition state?
- Is the primary action inverse neutral rather than brand-colored?
- Do type, spacing, icon, radius, row-height, and elevation match the component
  recipe in this file?
- Are default, hover, active, focus, selected, disabled, pending, and failure
  states handled where applicable?
- Do keyboard behavior, accessible names, focus restoration, reduced motion,
  long translations, and constrained widths work?
- Are light and dark themes both correct?
- Was the affected flow verified in the isolated real Tauri application with a
  screenshot of the final normal state and any critical transient state?

When a screenshot feels wrong, compare it in this order: composition, surface
hierarchy, typography, spacing, control sizing, radii, elevation, then color.
Do not try to rescue incorrect composition by adding accent color or decoration.
