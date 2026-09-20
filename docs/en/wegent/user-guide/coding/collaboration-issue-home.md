---
sidebar_position: 12
---

# Creating an Issue in Collaboration

New Issue opens a content-first composer. Its project picker stays inside the top of the composer. Hovering or focusing a sidebar project reveals New conversation, which opens this composer with that project selected. Clicking the project name still opens its board.

- `@` selects a project member, agent, or collaboration group. The first valid mention becomes the owner automatically; the bottom control displays its name.
- Use the searchable owner popup to change or clear ownership. Manual selection takes precedence over mentions. Mentioning multiple people does not create multiple owners.
- `#` references another Issue in the current project without changing ownership.
- Plugin, plan-mode, and slash-command menus from Tasks are unavailable here. Creation opens the new Issue in its project.
- After switching projects, remove or replace references belonging to the previous project.

Local projects from Tasks appear automatically under Local workspace. Reloading does not duplicate them. Remote code projects are excluded, and archived collaboration projects are not restored by synchronization. Separate project identities remain separate even when their names match.

The Executor stores local ownership; the backend stores cloud ownership. A collaboration group owner is a project group reference, not a resource-library Agent's Team ID. Assigning it does not automatically execute the group's workflow.

## Regression verification

`pnpm --filter wework e2e:desktop --segment collaboration-shared-core` uses isolated Electron, the real backend, and the local Executor. Only model services are simulated. Added checks cover:

1. Icon-free project labels, stable row height, and project-specific new conversation navigation.
2. Creating Issues through member, agent, and group mentions, then checking persisted ownership through the API.
3. Issue-only `#` suggestions, distinct reference icons, and saved references.
4. Manual ownership changes and clearing without native selects; no task slash menu.
5. Seeding a local project through the real Tasks project API, reloading twice, and verifying one imported project with a working collaboration entry.

Cloud fixtures are archived by the checkpoint cleanup. Local fixtures live only in the test Executor home. Failures retain runner logs; tests do not skip or retry to hide failures.
