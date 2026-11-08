---
sidebar_position: 2
---

# Interface navigation and feature locations

Use this page to find an entry point, then follow the linked usage guide. It describes the desktop main window; popup, narrow-window and operating-system layouts may differ. Paths below are click sequences, not commands to enter.

## Know the interface

| Area                | Location                               | Purpose                                                                                                       |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Left sidebar        | Left edge of the main window           | Create tasks, search, open projects and previous conversations; the account menu at the bottom opens settings |
| Top tab bar         | Top of the main window                 | Switch between open Tasks, Collaboration (project spaces) and Agent pages; use + to add a tab                 |
| Conversation        | Center of a task page                  | Read replies, inspect tool activity and answer confirmation requests                                          |
| Composer            | Below the conversation                 | Enter tasks, attach files, select models, permissions, plugins or Skills                                      |
| Right workspace     | Right of the conversation; collapsible | Files, review, built-in browser and other workspace tabs                                                      |
| Bottom panel        | Below the conversation; collapsible    | Terminal and other auxiliary sessions                                                                         |
| Settings navigation | Left side after opening settings       | Select pages grouped under Personal, Integrations, Coding and Archived                                        |

On macOS, the default shortcuts are `Command+B` for the left sidebar, `Option+Command+B` for the right workspace and `Command+J` for the bottom panel. For other systems or customized bindings, check **Settings → Shortcuts**.

## Where do I go?

| Goal / common search terms                              | Click path                                                   | Conditions and details                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New task / new conversation                             | Left sidebar → New task                                      | [Getting started](./getting-started.md)                                                                                                                                              |
| Search previous tasks                                   | Top of left sidebar → magnifying glass                       | Expand the sidebar to find the search icon                                                                                                                                           |
| Open a code directory / add project                     | Left sidebar → add button beside Projects → Local project    | Choose a local directory; use Cloud project for remote directories. See [Projects and workspaces](./projects.md)                                                                     |
| Start a conversation in a project                       | Left sidebar → project → new conversation entry              | Add or open the project first; its workspace differs from a standalone conversation                                                                                                  |
| Collaboration board / project spaces / Issues           | Top tab bar → + → Collaboration → select project             | Switch directly if a Collaboration tab is already open. A code project is not a project space. See [Projects and workspaces](./projects.md)                                          |
| Manage agents                                           | Top tab bar → + → Agent                                      | Opens the cloud connection flow when disconnected; Team resources are Agents, Bot resources are Bots                                                                                 |
| Questions and project work awaiting me                  | Top tab bar → + → Needs your input                           | Pending work, not archived history. See [Questions and project work](./workbench.md#ai-questions)                                                                                     |
| Filter one project's Issues needing me                  | Collaboration → select project → board toolbar → Needs my action | Temporary filter; does not change saved views. See [Project work and waiting time](./workbench.md#project-pending-work)                                                            |
| Check how long a workflow has waited for me              | Needs your input → select project work or a question         | Requires reliable evidence of this handoff. See [Waiting time and workflow analysis](./personal-stand-in.md#waiting-time-and-workflow-analysis)                                      |
| Configure project devices, repositories, initialization | Project space → Project settings → Execution environment     | Not the global execution-environment settings; AI execution requires an initialized online device                                                                                    |
| Project AI / project manager                            | Project settings → AI team / Automatic processing            | See [Project AI manager](./project-ai-manager.md) for current equivalents; do not look for the old bottom-of-board button                                                            |
| Personal stand-in                                       | Left sidebar → My Stand-in                                   | Beta feature; source details → Processing has separate immediate-handling and conversation rows. See [Personal stand-in](./personal-stand-in.md) |
| Stop stand-in / change binding | Left sidebar → My Stand-in → Stand-in details → Manage stand-in → Stop stand-in at the bottom left of settings | Rebinding choices appear only after stopping the entire stand-in and cancelling its tasks. See [Instance binding and stopping](./personal-stand-in.md#instance-binding-and-stopping) |
| Change model / reasoning level                          | Task composer → model selector                               | Add a model in settings if none is available. See [Model settings](./user-guide/model-settings.md)                                                                                   |
| Attach files, select Skill / plugin                     | Task composer → + or capability selector                     | See [Working with AI](./tasks.md) and [Plugins and Skills](./plugins-and-skills.md)                                                                                                  |
| Read-only, workspace, full-access permissions           | Left composer toolbar → permission icon beside quick phrases | Hover to see the current mode; changing it does not authorize an external app                                                                                                        |
| Browse / edit files                                     | Right workspace → Files                                      | Open the panel first; writable text autosaves. See [Code workbench](./workbench.md)                                                                                                  |
| Diff / code review                                      | File changes below an assistant reply → Review               | Git-capable tasks; changes are read from the execution device                                                                                                                        |
| Open / preview a webpage                                | Right workspace → new-tab menu → Browser                     | Not external Chrome. See [Built-in browser](./browser.md)                                                                                                                            |
| Open terminal                                           | Bottom panel → + → Terminal                                  | Starts in the task working directory; expanding the panel alone does not create one                                                                                                  |
| Version / check for updates                             | Bottom-left account menu → About / Check for updates         | Separate actions. See [Settings and data](./settings.md)                                                                                                                             |

Pending business questions offer **Talk it through** on the task question card or in **Needs your input** question details. It opens a discussion tab alongside browser and files in the original task's right sidebar. See [Handle AI questions](./workbench.md#ai-questions) for its purpose and restrictions.

## Sidebar feature entries

### Jump to individual feature controls

| Search terms                                                                                                    | Detailed steps                                                                          |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Send shortcut, follow-ups, fixed tabs, concurrency, privacy, appearance, context, Appshots, computer use, Hooks | [Individual settings controls](./settings.md#settings-controls)                         |
| Browser full control, link targets, history, downloads, cache/cookies, device emulation                         | [Browser controls](./browser.md#browser-controls) and toolbar instructions on that page |
| Providers, custom endpoints, vision sidecar, connection testing, capabilities, Catalog                          | [Model controls](./user-guide/model-settings.md#model-controls)                         |
| Attachments, drawing, plan mode, Goal, queues, task views, personal schedules                                   | [Composer and task controls](./tasks.md#task-controls)                                  |
| Project menus, members, assignment, archive/restore, boards, execution environments                             | [Project operations](./projects.md#project-controls)                                    |
| File path menus, IDE, terminal, message actions, Diff review, tabs                                              | [Workbench operations](./workbench.md#workspace-controls)                               |

For installation, individual Skills and authorization, see [Plugins and Skills](./plugins-and-skills.md); for device management, [Devices and cloud work](./devices.md); for roles and sources, [My Stand-in](./personal-stand-in.md). Detailed workflows stay in their owning topics rather than being duplicated here.

Internal routes below support version maintenance and automated checks; they are not website URLs. Use the click paths for navigation.

| Click path                  | Purpose and conditions                                                                                     | Internal route |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| Left sidebar → Scheduled    | View scheduled tasks                                                                                       | `/automations` |
| Left sidebar → Plugins      | Find, install and manage plugins and app authorization. See [Plugins and Skills](./plugins-and-skills.md)  | `/plugins`     |
| Left sidebar → Applications | Open the applications page                                                                                 | `/sites`       |
| Left sidebar → Cloud work   | View devices and cloud projects; connect first if disconnected. See [Devices and cloud work](./devices.md) | `/cloud-work`  |

### Space and auxiliary feature links

| Search terms                                                              | Detailed steps                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Space members, global agents/teams/devices, Runner, templates, milestones | [Space and resource operations](./projects.md#workspace-resource-controls) |
| Stand-in memory, scope, edit and forget                                   | [Memory controls](./personal-stand-in.md#stand-in-memory-controls)         |
| Experimental lead conversation, takeover, stop, publish to Issue          | [Project lead controls](./personal-stand-in.md#project-lead-controls)      |
| Site PV/UV, visit dates and analytics                                     | [Site visit data](./plugins-and-skills.md#site-analytics-controls)         |
| System drag, new chat/follow-up and quick-phrase stash                    | [Drag and stash](./settings.md#system-drag-controls)                       |
| History search, multi-delete, date groups and retry                       | [Browsing history](./browser.md#browser-history-controls)                  |
| Bell, mark all read, notification channels and IM target                  | [Notification center](./workbench.md#notification-controls)                |
| Process resource usage, filtering, launch details and pinning             | [Process Explorer](./troubleshooting.md#process-explorer-controls)         |

## Settings quick reference

Open **bottom-left account menu → Settings**, then select the group and page below. The macOS default shortcut is `Command+,`. The Plugins settings page configures Codex plugin runtime behavior, unlike the sidebar plugin marketplace; Runtime is not the Node.js executable setting.

| Group → page                    | What to find / visibility                                                                                    | Internal route                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Personal → General              | Language, feature mode, experimental features, startup, task execution, storage cleanup                      | `/settings`                             |
| Personal → Cloud connection     | Wegent sign-in, connections and devices. See [Devices and cloud work](./devices.md)                          | `/settings/connections`                 |
| Personal → Appearance           | Theme and background                                                                                         | `/settings/appearance`                  |
| Personal → Context              | Personality and task context preferences                                                                     | `/settings/personal/context`            |
| Personal → Models               | Codex sign-in, custom models, Catalog. See [Model settings](./user-guide/model-settings.md)                  | `/settings/personal/models`             |
| Personal → Proxy                | Local and cloud model network proxies                                                                        | `/settings/personal/proxy`              |
| Personal → Shortcuts            | View and customize keyboard bindings; desktop only                                                           | `/settings/personal/keyboard-shortcuts` |
| Personal → Quick phrases        | Reusable prompts                                                                                             | `/settings/personal/quick-phrases`      |
| Personal → Runtime              | Runtime profiles and project defaults                                                                        | `/settings/personal/runtimes`           |
| Personal → About                | Application version and information                                                                          | `/settings/about`                       |
| Integrations → Appshots         | Application snapshot configuration; desktop only                                                             | `/settings/appshots`                    |
| Integrations → Computer use     | Computer-control configuration; desktop only                                                                 | `/settings/computer-use`                |
| Integrations → Plugins          | Codex plugin runtime configuration. See [Plugins and Skills](./plugins-and-skills.md)                        | `/settings/plugins`                     |
| Integrations → Browser          | Download directory, browser data and cache                                                                   | `/settings/browser`                     |
| Coding → Execution environments | Node.js and execution-environment configuration. See [Settings and data](./settings.md)                      | `/settings/execution-environments`      |
| Coding → Coding tools           | OpenCode, Claude Code, Kimi Code; experimental                                                               | `/settings/harnesses`                   |
| Coding → Hooks                  | Runtime hook configuration                                                                                   | `/settings/hooks`                       |
| Coding → Git hosting            | GitHub / GitLab connections; Git plugin entry in developer mode. See [Git connections](./git-connections.md) | `/settings/git-hosting`                 |
| Coding → Worktrees              | Worktree location, retention and cleanup; Git plugin entry in developer mode                                 | `/settings/worktrees`                   |
| Archived → Archived tasks       | Find, restore and delete archived conversations                                                              | `/settings/archived-conversations`      |

## When an entry is missing

1. Confirm that you are in the desktop main window and the relevant sidebar or panel is expanded. Hover over icon buttons to read their names.
2. Check context: the task model selector, a project's settings and global application settings are different surfaces.
3. Check feature mode and experimental features in **Settings → General**. Focus mode hides Git hosting and Worktrees and disables the built-in Git plugin. Experimental entries may also be hidden. Finding ordinary features does not require full-access permissions.
4. For cloud features, check connection and device status; for project management, check your project role; for plugin features, check installation, enablement and authorization for that particular app. A missing entry does not by itself mean you are signed out.
5. Check the version in **About** and report your OS, current page, goal and visible controls. Documentation ships with the app version; report a documentation gap if it still does not match, rather than guessing menu locations.

## Coverage and maintenance

This page indexes locations; linked topic guides own detailed procedures to avoid duplicate instructions. Automated checks compare settings pages and registered sidebar entries against real DSH declarations in both languages, including names, groups and visibility flags. Additions, removals and renames must update this page in the same change.

Composer controls, project menus and account menus still require manual code-review checks. Automated tests cannot prove that every button is documented or that the running layout matches. See repository `wework/AGENTS.md` for maintenance rules. Builds copy both documentation trees into bundled wework-docs; repository edits do not instantly update older installed versions.
