---
sidebar_position: 37
---

# Integrating project navigation

W-0021 delivers the shared switcher and shell. W-0022 owns web and desktop host wiring, including the `collab.projectViews.v2` release defaults: enabled in beta and disabled in stable.

## Options and content

`@wegent/collaboration` exports `ProjectViewSwitcher`, `groupedProjectViewMetadata`, and `createProjectViewSelectionMemory`. Pass the metadata map to `CollaborationProjectViewShell.viewMetadata` to opt in. Component options and shell extension options also accept their corresponding `group` / `parent` metadata.

Every available option must have complete metadata matching the fixed hierarchy. Missing, partial, or inconsistent metadata preserves the existing flat order without dropping options. Groups add no route IDs: changes still return `board/calendar/gantt/milestones/table/files/manage`.

The switcher consumes available options. Standard views retain existing shell permission filtering; hosts compute extension availability. Omit unavailable capabilities. Keep supported empty views and their existing empty content. Management disappears when neither management view is available.

## Session selection

Create one `createProjectViewSelectionMemory()` per authenticated host session. Pass it through `viewSelectionMemory` together with `viewSelectionKey = JSON.stringify([userId, projectStore, projectId])`. Destroy it on logout and recreate it after refresh or restart. Never persist it. This preserves choices across component remounts and project switches while isolating identities, stores, and projects. The component's default local memory lasts only for its current mount.

Only plan choices and timeline segments are remembered. Management enters files each time, or project settings when files is unavailable. An explicit controlled view overrides memory. Mounting never requests navigation, and unavailable remembered views are revalidated.

## Unavailable links and layout

Grouped navigation resolves an unavailable view to the first available entry in its group, then work. The shell displays safe content and reports the result through `onUnavailableView` without calling `onViewChange`. W-0022 must preserve the URL and display the required notice. Ungrouped hosts retain their existing state correction behavior.

Grouped navigation sits below the fixed title bar. Work has no secondary row or placeholder. Below a project container width of 720px, secondary entries become a menu while calendar/gantt segments stay outside it. Primary entries never wrap; the secondary area can wrap. Both themes and hosts share the component structure.

## Design delivery and verification

`packages/collaboration/design-system/project-view-switcher.json` describes registration. `ProjectViewSwitcher.stories.tsx` provides nine CSF states with a light/dark `theme` control. `CompactOpen` opens its menu through a play function. Existing collaboration CI runs the component and shell tests.

The design reference repository's complete registry, Storybook runtime, and `design_system_sync.py` are outside Wegent. Local tests render every story in both themes. Import the registration and stories into the design repository to run its build and sync checks; do not fabricate components to satisfy the registry count.
