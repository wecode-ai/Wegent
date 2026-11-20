---
sidebar_position: 30
---

# Wework component library

Wework uses the React behavior layer from [UI SDK](https://github.com/vercel-labs/ui), pinned to `0.1.0-beta.10` for both `@ui-sdk/core` and `@ui-sdk/react`. The SDK owns semantics, keyboard behavior, focus and popups. Project components own visual tokens, sizing and domain adapters. Follow `wework/DESIGN.md` for visual decisions.

See the [component migration review](./component-migration-review.md) for per-page source conclusions, actual Story observations and unverified boundaries.

## Entry points

| Entry                                     | Contents                                                              |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `@wegent/collaboration/controls`          | Base controls, settings layouts, menus and permission selection       |
| `@wegent/collaboration/controls/entities` | People, collaborators, group members, agents, models and board fields |
| `wework/src/components/library/index.ts`  | Desktop entry including project spaces, devices and participants      |
| `wework/src/stories/`                     | Runnable examples of production components                            |
| `wework/.storybook/`                      | Isolated preview, themes, localization and AI MCP configuration       |

Shared implementations live in `packages/collaboration/src/controls/`. Domain adapters remain with their owners and are exported through the common entry. Callers own requests, permission checks, identifiers and persistence.

## Run

```bash
pnpm --filter wework storybook
pnpm --filter wework storybook:build
pnpm --filter wework components:audit
```

The local preview defaults to `http://127.0.0.1:6006`, with English, Chinese, light and dark modes. Examples use local state and sample data without starting desktop runtimes or connecting personal accounts.

Current examples cover buttons, fields, textareas, checkboxes, switches, selects, searchable and multiple selection, sliders, segmented controls, settings rows, dialogs, models, permissions, collaborators and devices. Applicable examples include disabled, read-only, empty, loading, failed and indeterminate states.

## AI access

Storybook enables `@storybook/addon-mcp` and component manifests. An HTTP MCP client can connect to `http://127.0.0.1:6006/mcp` after startup to inspect documentation and examples. The repository does not edit personal MCP configuration.

Find the existing component and Story before editing production callers. `componentCatalog.test.tsx` uses the UI SDK agent to verify discovery and operation of the base composition by accessible name. Name every control and provide stable option values. Display names must not replace domain identifiers.

## Consistent usage

Use `ActionMenu` for commands and `SelectField` for choosing a value. Use `SearchableSelect` for searching, grouping and multiple selection, while preserving domain request cancellation and permission filtering. Use `Switch`, `Checkbox` and `RadioGroup` for their corresponding settings. Page tabs use `TabsRoot`, `TabsList` and `TabsTab`. Use `appearance="surface"` in desktop window chrome, where the tab background identifies the active workspace. Use `SegmentedControl` for short setting choices.

Use `activateSelected` when activating any single-select option starts a follow-up action. For example, choosing the current project again lets a task link to a different Issue in that project.

Settings pages reuse `SettingsGroup` and `SettingsRow`. Controls serving the same purpose share dimensions, radii, selected and disabled states, and feedback. Containers express layout differences. Mobile targets are at least 44px; desktop density follows the design guide. Production text uses i18n.

Forms compose the shared `Field`, `FieldLabel`, `FieldDescription` and `FieldError` parts with visible labels. Inputs and selects use full-width `default/outline` controls: 36px on desktop and 44px on mobile. `MenuSelect field` requires a `label` and uses the same composition; settings rows and toolbars keep `dense/plain` with a stable `accessibleLabel`.

Use `ComposerContextButton` for composer context actions and `appearance="composer"` on `SelectField` or `SearchableSelect` when choosing a value. Collaboration projects use `ComposerProjectSelector` with project options and an accessible name. Compare idle, hovered and expanded states in `Business/ComposerProjectSelector → Composer Context Row`. The shared controls provide typography, color, dimensions and focus states. Callers supply data, content and layout widths.

Use the same appearance for assignee and plugin pickers in composer toolbars. A selected workspace shows its name. Discussion toolbar actions wrap when space is limited so that their labels stay readable. Use `appearance="property"` for inline Issue property pickers and the outlined appearance for edit form fields.

Use `ParticipantField` and `ParticipantToken` to show selected people and the add action in one field, as in Issue and project creation.

Use the `Button` variants `primary`, `ghost`, `outline` and `destructive` for dialog footer actions. Inline deletion uses `DeleteIconButton` or `destructive-ghost`. Controls in the same group share a `size`, and Button supplies the disabled treatment.

## Popup ownership

`DialogSurface` composes SDK Dialog or AlertDialog. Callers control dismissal and pending-operation cancellation gates. Existing application backdrops can use its default inline layout; browser top-layer content uses `inline={false}`. Embedded steps use `InlinePanel` for Escape layering and focus recovery; the parent retains modal isolation.

Keep one focus and dismissal owner per popup. Remove old Escape, Tab loops, background isolation and positioning listeners when adopting SDK popups. Specialized editors retain their editing behavior; surrounding controls use the project library.

## Coverage and verification

Migration is still in progress. The current examples do not prove every production interface has migrated. `components:audit` reports native JSX controls and handwritten widget roles in production source, as well as native controls that built-in DSH clients create with React `createElement`. JSX elements supplied for SDK render composition and hidden browser file inputs are excluded. Review its findings alongside production usage, type checking, behavior tests and real previews.

Update examples, documentation and callers together for public component changes. Preserve existing test IDs. Do not commit temporary screenshots, logs or generated builds. Existing push hooks and CI own full regression runs; follow repository policy for focused local verification.

## Business examples

| Storybook section                | Behavior to inspect                                                             |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Business/IssueOwnerPicker        | Unassigned, people, disabled assignment                                         |
| Business/MemberSearchPicker      | Search, multiple selection, loading, directory errors, pending save             |
| Business/ProjectAgentPicker      | Agent selection, empty directory, loading, failure and disabled pending actions |
| Business/GroupParticipantsEditor | Leader, members, responsibilities and read-only roster                          |
| Business/ProjectSpacePickerMenu  | Local/cloud grouping, search, sorting and clearing selection                    |
| Business/ProjectBoardGroupPicker | Board field search and empty fields                                             |
| Business/BoardViewTagPicker      | Existing tags, used tags, new tags and length validation                        |

These are production components with local state and deterministic sample data. Use the toolbar to compare Chinese/English and light/dark. A static build proves module resolution, not browser rendering or production services.

The local MCP handshake, tool discovery, `docs-list`, `docs-show` for ProjectAgentPicker and `stories-preview` were verified against the running development server. Preview URL generation is not a browser interaction test.

The public catalog also includes Business/IssueParticipantPicker (search, empty, directory failure and disabled states) and Business/GitAccountConfiguration (normal, inline, open failure and device permission cases). Git configuration examples record destinations locally; they never open external settings or credentials.

Business/BranchPicker covers loading, empty branches, retry after directory failure, and disabled branch actions. Controls/SelectField includes KeyboardSequence with fields before and after the select for focus navigation checks.

## Example index and public API coverage

These links open runnable Story source. Examples use production controls or traced production composition adapters. The toolbar supplies Chinese/English and light/dark themes. Add new public controls to this index.

| Story source                                                                                   | Coverage                                                                                            |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [ActionButtons](../../../wework/src/stories/ActionButtons.stories.tsx)                         | Production component and applicable states                                                          |
| [BoardViewTagPicker](../../../wework/src/stories/BoardViewTagPicker.stories.tsx)               | Production component and applicable states                                                          |
| [BranchPicker](../../../wework/src/stories/BranchPicker.stories.tsx)                           | Production component and applicable states                                                          |
| [Button](../../../wework/src/stories/Button.stories.tsx)                                       | Production component and applicable states                                                          |
| [Checkbox](../../../wework/src/stories/Checkbox.stories.tsx)                                   | Production component and applicable states                                                          |
| [Collapsible](../../../wework/src/stories/Collapsible.stories.tsx)                             | Closed, initially expanded; retained panel input                                                    |
| [ComposerComparison](../../../wework/src/stories/ComposerComparison.stories.tsx)               | Production component and applicable states                                                          |
| [ComposerProjectSelector](../../../wework/src/stories/ComposerProjectSelector.stories.tsx)     | Production component and applicable states                                                          |
| [DeviceSelect](../../../wework/src/stories/DeviceSelect.stories.tsx)                           | Production component and applicable states                                                          |
| [Dialogs](../../../wework/src/stories/Dialogs.stories.tsx)                                     | Production component and applicable states                                                          |
| [Feedback](../../../wework/src/stories/Feedback.stories.tsx)                                   | Production component and applicable states                                                          |
| [GitAccountConfiguration](../../../wework/src/stories/GitAccountConfiguration.stories.tsx)     | Production component and applicable states                                                          |
| [GroupParticipantsEditor](../../../wework/src/stories/GroupParticipantsEditor.stories.tsx)     | Production component and applicable states                                                          |
| [IconButton](../../../wework/src/stories/IconButton.stories.tsx)                               | Production component and applicable states                                                          |
| [IssueOwnerPicker](../../../wework/src/stories/IssueOwnerPicker.stories.tsx)                   | Production component and applicable states                                                          |
| [IssueParticipantPicker](../../../wework/src/stories/IssueParticipantPicker.stories.tsx)       | Production component and applicable states                                                          |
| [LayoutRegression](../../../wework/src/stories/LayoutRegression.stories.tsx)                   | Production component and applicable states                                                          |
| [MemberSearchPicker](../../../wework/src/stories/MemberSearchPicker.stories.tsx)               | Production component and applicable states                                                          |
| [MenuPrimitives](../../../wework/src/stories/MenuPrimitives.stories.tsx)                       | Production component and applicable states                                                          |
| [Menus](../../../wework/src/stories/Menus.stories.tsx)                                         | Production component and applicable states                                                          |
| [ModelSelector](../../../wework/src/stories/ModelSelector.stories.tsx)                         | Production component and applicable states                                                          |
| [OverlayParts](../../../wework/src/stories/OverlayParts.stories.tsx)                           | Arrows, shortcut hints, context and data menus                                                      |
| [PermissionModeSelector](../../../wework/src/stories/PermissionModeSelector.stories.tsx)       | Production component and applicable states                                                          |
| [Popover](../../../wework/src/stories/Popover.stories.tsx)                                     | Production component and applicable states                                                          |
| [Progress](../../../wework/src/stories/Progress.stories.tsx)                                   | Production component and applicable states                                                          |
| [ProjectAgentPicker](../../../wework/src/stories/ProjectAgentPicker.stories.tsx)               | Production component and applicable states                                                          |
| [ProjectBoardGroupPicker](../../../wework/src/stories/ProjectBoardGroupPicker.stories.tsx)     | Production component and applicable states                                                          |
| [ProjectCollaboratorPicker](../../../wework/src/stories/ProjectCollaboratorPicker.stories.tsx) | Production component and applicable states                                                          |
| [ProjectSpacePickerMenu](../../../wework/src/stories/ProjectSpacePickerMenu.stories.tsx)       | Production component and applicable states                                                          |
| [RadioGroup](../../../wework/src/stories/RadioGroup.stories.tsx)                               | Production component and applicable states                                                          |
| [RangeSlider](../../../wework/src/stories/RangeSlider.stories.tsx)                             | Production component and applicable states                                                          |
| [Resizable](../../../wework/src/stories/Resizable.stories.tsx)                                 | Horizontal, vertical, disabled, controlled layout and commit saving (local state)                   |
| [ScrollArea](../../../wework/src/stories/ScrollArea.stories.tsx)                               | Production component and applicable states                                                          |
| [SearchableSelect](../../../wework/src/stories/SearchableSelect.stories.tsx)                   | Production component and applicable states                                                          |
| [SegmentedControl](../../../wework/src/stories/SegmentedControl.stories.tsx)                   | Production component and applicable states                                                          |
| [SelectField](../../../wework/src/stories/SelectField.stories.tsx)                             | Production component and applicable states                                                          |
| [Settings](../../../wework/src/stories/Settings.stories.tsx)                                   | Groups, responsive navigation and model connection form                                             |
| [Switch](../../../wework/src/stories/Switch.stories.tsx)                                       | Production component and applicable states                                                          |
| [Tabs](../../../wework/src/stories/Tabs.stories.tsx)                                           | Production component and applicable states                                                          |
| [Field](../../../wework/src/stories/Field.stories.tsx)                                         | Form labels, descriptions, errors and default/outline controls                                      |
| [TextField](../../../wework/src/stories/TextField.stories.tsx)                                 | Production component and applicable states                                                          |
| [Textarea](../../../wework/src/stories/Textarea.stories.tsx)                                   | Production component and applicable states                                                          |
| [Toast](../../../wework/src/stories/Toast.stories.tsx)                                         | Success, error, loading; real anchored long TransientNotice, 2200ms dismissal and persistent action |
| [VirtualTree](../../../wework/src/stories/VirtualTree.stories.tsx)                             | Empty, disabled, 1000 virtual rows, revealing a distant node                                        |
| [InlinePanel](../../../wework/src/stories/InlinePanel.stories.tsx)                             | Real TemplatePanel embedded in its parent Dialog; regular/pending steps, Escape and focus recovery  |

| [AutomationTaskSelection](../../../wework/src/stories/AutomationTaskSelection.stories.tsx) | Production automation task search, offline items and empty state |
| [ConversationQueue](../../../wework/src/stories/ConversationQueue.stories.tsx) | Production components and relevant states |
| [PlanningDragAndDrop](../../../wework/src/stories/PlanningDragAndDrop.stories.tsx) | Production components and relevant states |
| [RuntimeSettingsPage](../../../wework/src/stories/RuntimeSettingsPage.stories.tsx) | Production components and relevant states |
| [Sortable](../../../wework/src/stories/Sortable.stories.tsx) | Production components and relevant states |
| [TaskDescriptionEditor](../../../wework/src/stories/TaskDescriptionEditor.stories.tsx) | Production components and relevant states |
| [ViewportReview](../../../wework/src/stories/ViewportReview.stories.tsx) | Production components and relevant states |

The public entry audit below excludes type-only exports. Parts are shown in valid compositions rather than isolated from their roots. This is source coverage, not acceptance of every product page.

| Category                        | Count | Missing examples                                         |
| ------------------------------- | ----- | -------------------------------------------------------- |
| Direct production examples      | 100   | 0                                                        |
| Production composition examples | 5     | 0                                                        |
| Nonvisual APIs                  | 7     | Contexts, controllers and toaster; used with their roots |

`Resizable` delegates dragging and keyboard sizing to the SDK. Save in `onLayoutCommit`; update controlled layouts in `onLayoutChange`. `CollapsibleRoot/Trigger/Panel` replace independent disclosure logic. `ToastRegion` owns a local toaster queue; `TransientNotice` supplies business messages and anchoring. Action notices persist, ordinary notices dismiss automatically, and example callbacks remain stable.

Index, format and type checks do not replace browser interaction verification of new examples. Prior static build and MCP success does not automatically validate later additions.

Use `InlinePanel` for a step inside an existing dialog. It owns Escape layering and focus recovery without adding a modal role. The example composes the real `TemplatePanel`; the parent dialog retains background isolation and overall cancellation.

The initial inventory covered 52 Story files and 112 public value exports. Of those exports, 100 had direct examples, 5 have production composition examples, and 7 are nonvisual APIs. `SortableDragArea` is demonstrated with an independent keyboard handle and text fields excluded from pointer activation. This inventory comes from public exports and Story source. Source review, running Story checks, and native production-page acceptance are separate evidence.
