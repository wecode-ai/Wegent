---
sidebar_position: 3
---

# Projects and workspaces

<a id="project-controls"></a>

<!-- ui-source: ../packages/collaboration/src/project-manage/ProjectSettingsPage.tsx -->
<!-- ui-source: ../packages/collaboration/src/platform/ResourceCatalogPage.tsx -->
<!-- ui-source: ../packages/collaboration/src/templates/CollaborationTemplatePage.tsx -->
<!-- ui-source: ../packages/collaboration/src/milestones/MilestonesPage.tsx -->
<!-- ui-source: src/features/todo/WeworkCollaborationPlatform.tsx -->
<!-- ui-source: ../packages/collaboration/src/platform/CollaborationPlatformNavigation.tsx -->

## Collaboration spaces and global resource catalogs

<a id="workspace-resource-controls"></a>

Open **top + → Collaboration**. Local projects appear directly under **Local projects**. Remote projects use **Remote projects → space → project**. Spaces expand by default and collapse independently; each project appears only once. Use the **+** beside either group to create a project without first choosing or creating a collaboration space. Remote projects require a cloud connection. These groups describe project storage; configure execution devices separately inside the project.

The local list does not expose the internal local space. Click the **Local projects** heading to manage device projects. Use the arrow beside a remote space to collapse or expand its projects. Scroll the sidebar vertically when its content exceeds the window height to reach lower spaces and entries. Existing membership inheritance, project roles, and administration permissions continue to apply. Project-only members can open their projects directly; seeing a parent space name does not grant space access. The project picker defaults to local/remote groups; choose **Filter by collaboration space** to use space groups.

For remote projects, **Choose a workspace** initially selects **Default space**, or you can choose an existing space. The first use creates an independent default space, which later requests reuse. Existing business spaces and their projects are not adopted or moved. The add-folder button beside Remote projects creates a space. Local projects stay on the current device and have no redundant space selector. Switching spaces preserves the project name and description and clears the previous space's member, agent, and template selections; configure these again in the target space before creating.

Global catalogs, space settings, and project settings remain separate levels. Code directories are separate resources, and project AI team settings do not replace space membership management.

| Feature                           | Entry and steps                                                                                                                              | Conditions and limits                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Agents / Teams / Devices catalogs | Select the left navigation item, search/filter All, Created by me or Team shared; create with the appropriate owner and save the form        | Not the project member list; creation/deletion depends on resource type and permission                                      |
| Add resource to space             | Resource row → Add to space → choose space → confirm; Settings opens its configuration                                                       | Does not expand all project members' permissions or move code directories                                                   |
| Space name/description            | Space-name … → Space settings → Basic information → edit → Save                                                                              | Requires space management permission; not project renaming                                                                  |
| Cloud space members               | Space settings → Collaboration members → Members → Invite → search/choose role → click result                                                | Clicking submits; role/removal actions request immediately and remain constrained by inherited membership/management rights |
| Transfer ownership                | Owner selects a new owner on the space members page, reviews and transfers                                                                   | Previous owner retains administrator permissions; unrelated to assigning an Issue                                           |
| Space agents/teams                | Space settings → Collaboration members → Agents / Teams; add/create and configure lead, members, rules and execution requirements, then save | Removing a shared association differs from deleting a project-owned group; inspect impact                                   |
| Space execution environment       | Space settings → Execution environment → add/share                                                                                           | Separate from project repository initialization; depends on storage type and capabilities                                   |

### Clean up offline device registrations

<a id="offline-device-cleanup"></a>

Open **Top + → Collaboration → Devices**. Use the device ID and last online time to find the historical registration. Select **Delete offline device** on its row, review the registration number and affected spaces, then confirm.

You can remove a registration you own when it is offline and has no running tasks. The current device is protected, as are records that could belong to it while its local identity is unavailable. Removing the registration takes it out of the device selectors in those spaces and preserves device files and execution history. See [Offline Device Handling](../wegent/user-guide/ai-devices/local-device-support.md#offline-device-cleanup) for last online display and reconnection behavior.

### Register a space Runner

When supported for a cloud space, use the create action under **Space settings → Execution environment** to open **Register workspace runner**. Enter its name and register. Follow the dialog to securely configure `DEVICE_ID`, `WEGENT_AUTH_TOKEN` and `WEGENT_BACKEND_URL` on the target server and run Executor, then verify online status in Wework.

Credentials are shown only this time. Do not put their values in chat, documents or screenshots; retain them through your organization's secure process before closing. Removing a public space environment revokes its credentials. Registration does not prove the process started, and cloud connection status does not establish Runner availability.

## Collaboration templates and configuration sharing

<a id="collaboration-template-models"></a>

When applying a template with Agents to an existing project or workspace, choose their model in **Confirm collaboration setup**, then click **Apply template**. Each Agent runtime has its own model field; new Agents of the same runtime use that selection. An existing default is preselected and can be changed without changing device defaults. Applying is blocked until a model is selected. If no models are available, add one in Settings and **Refresh** the list in the dialog. Failed loads can be refreshed without losing team names or member choices.

<a id="template-controls"></a>

To delete an imported personal template, open **Collaboration → Templates → My templates → Delete template** on its card, check its name and confirm. Cancel leaves it unchanged. Only your own personal templates have this action; built-in and other users’ templates cannot be deleted. Unsynced drafts can be deleted offline. Synced templates require a cloud connection and are removed from your account and this device. Existing projects and groups are unaffected. On failure, the template remains available and you can retry in the dialog.

| Action                            | UI steps and result                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find templates                    | Collaboration left navigation → Templates → Discover, Available or My templates; search, refresh or use More                                                                    |
| Use                               | Open details → Use this template → choose the creation/application target and review configuration                                                                              |
| Import YAML                       | Import → .yaml/.yml (up to 1 MiB) → preview → save to My templates; resolve validation errors                                                                                   |
| Save/export project configuration | Project settings → Configuration sharing (requires template-store support) → import, save to My templates or export configuration YAML                                          |
| Save/export group configuration   | Use save/export template in team details; inspect content and sensitive information before sharing                                                                              |
| Sync/publish                      | Sync pending local content; publishing requires reviewing its confirmation before submitting. Save, sync and publish differ; unavailability does not mean content became public |

## New Issue content and assignee

Record an issue directly at the top of **Collaboration → My work**; choose the project and enter content. Type **@** to select an available member, agent or team; explicitly assign with the assignee control below. A manually chosen assignee takes precedence over mentions: mentioning multiple people does not assign them all.

<a id="personal-collaboration-home"></a>

### Personal collaboration home

The home defaults to a compact **Record an issue** composer. Choose a project, enter content, optionally assign it to a member, agent or team, and select **Record**. Recording does not directly launch a task; automatic handling of assigned Issues still follows the assistant settings. To begin immediately, select **Create task**; the draft and attachments carry into the Tasks composer with model, plugin, workspace, attachment, plan-mode and voice controls. Submitting automatically derives the Issue title from the content and creates the linked execution in one flow. Results use the existing Issue publication flow. The list stays visible and the new Issue and task open on the right. A rejected start retains the draft and retries the same Issue. Switching back to **Record an issue** preserves drafts.

Collaboration opens **My work** with **Assigned to me** selected, showing Issues whose assignee is you. Choose **Participating** for the broader participation list. Both scopes group issues by project and initially show **Unfinished** work. Choose **All** to include completed or cancelled issues. Pending questions explicitly addressed to you show **Needs my input** in the same list.

**Assigned to me** prioritizes questions, reviews and approvals addressed to you, followed by unstarted assignments, ongoing work and other unfinished issues. Within each category, priority precedes recent activity; finished and cancelled issues come last. **Participating** keeps issues needing your intervention first and otherwise uses recent activity. New comments and execution completion count as activity; execution heartbeats do not. Projects needing intervention come first, with other projects retaining their existing order. Both local and cloud stores apply ordering before pagination. Use **Sort** above the list to select **Needs my attention**, **Longest assigned**, **Recent activity**, or **Priority**. Issues show the age of their current assignment to you; reassignment resets it and missing assignment evidence does not fall back to creation time. Newly created Issues appear near the top and open on the right. Use **Open in project** in the detail header to view the Issue in its project.

Starting work through **Create task** prevents assistants from automatically taking over that assignment or reserving extra role tasks. Once AI title generation finishes, its title updates the new Issue's provisional title, preserving any manual title edit. A later reassignment can be handled by assistants again. Ordinary assignments made through **Record an issue** still follow assistant settings; one automatic assignment selects one matching role. A reservation awaiting Runtime creation shows **Waiting for assistant** and cannot open as a running task. After the Runtime creates the task, its original conversation becomes available.

**Record an issue** and **Create task** are parallel modes: select either label to switch while preserving the draft. The project selector has no background at rest and uses a subtle hover state. Issues appear in a project-grouped list with title, status and assignee kept together, followed by the summary, assignment comment and a single-line linked-task summary. The list does not use a multi-column card grid. Select an issue for details or a linked task to open its execution.

The right workspace uses the task interface's tab style and opens **Stand-in** by default. The assistant tab remains available alongside at most one Issue detail tab. Selecting another Issue replaces the current detail without navigating the list; selecting it again focuses that detail. The tab shows the Issue title, with its project and number in the tooltip. Closing the detail returns to the assistant. Unsubmitted edits are retained and restored when reopening the Issue. Only the visible stand-in conversation confirms messages as read. Details reuse the full board Issue workflow. Where the existing creation conditions allow it, **Create task** initially appears only beside **Linked tasks**. Once you scroll past that control, the complete **Let AI help me** action bar appears at the top; it disappears when you scroll back. It opens a second conversation pane in the same right-hand tab and widens the workspace. Linked tasks use the same second pane; closing the conversation returns to the Issue and closing the Issue returns to the home list.

**Stand-in** defaults to tasks grouped by role, with **In progress** and **Completed** sections per role; failed and cancelled work retains its actual status. **Needs my input** on the right contains only collaboration Issues explicitly waiting for you and opens the corresponding Issue. Select a task to continue its original conversation in the right pane and use Back to return. **Assistant settings** opens the existing primary configuration. This list includes only assistant tasks linked to collaboration Issues, excluding unrelated mail, calendar and general assistant work. If no enabled primary assistant or role connects an accessible board, **Connect a board so your assistant can help** guides you through the existing assistant setup. Creating an assistant or completing the earlier onboarding alone does not count as connecting a board.

Issue rows show title, status, assignee, tags, date and a content excerpt. When an actual assignment comment exists, **Assignment comment** shows its text and author. Assignment context and task bindings load in the same bounded page without per-Issue requests. One task-summary line shows the first two names, task count and live execution status. A single task opens directly; multiple tasks open a picker. Collaboration items awaiting you show a bell and **Needs my input**, linking to the Issue. Projects use readable group names, cards use #numbers, and detail tabs show Issue titles, with project names and numbers in their tooltips.

Discussions exceeding 20 activity entries preserve the first two and latest ten, with an expandable middle. Comment links and reply targets remain visible.

Notifications remain in the title-bar bell. Reading them does not resolve pending work. Failed list requests show an error and retry action. Reopening the home or focusing the app refreshes the list.

Type **#** and select a matching Issue from this project. After switching projects, recheck/reselect references rather than retaining invalid old-project links. This creates an Issue, not a runtime task, so do not assume task plan-mode/plugin/Skill-slash controls are available. Review project, assignee and references before submitting, then continue in details.

## Manage milestones

Open **Milestones** in the project. The Issue-detail selector only associates existing milestones and is not the management page.

| Feature         | Steps                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse/filter   | Switch Open/Closed, select a milestone for its Issues and use Back to leave details                                                                                    |
| Create/edit     | Create or edit a row, enter title, description and due date, then Save; Cancel discards                                                                                |
| Close/reopen    | Use the row action; this changes the milestone state without automatically completing its Issues                                                                       |
| Delete          | Verify the target and review confirmation/permissions; deletion differs from closing                                                                                   |
| Archived Issues | When the selected milestone contains archived Issues, use its Archived entry to view those records; not the Closed milestone filter or globally archived conversations |

## Members, discussion assignment and archival

| Feature                            | Steps                                                                                                                       | Conditions and result                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Add project member                 | Project settings → AI team → Members → Add member → search username/email → choose role → click result                      | Clicking adds immediately; no extra Save button; requires management permission                                    |
| Responsibilities, role and removal | Edit responsibilities/capabilities on the row and blur to save; change role/remove where allowed                            | Inherited membership, effective role and permissions constrain actions; not every member can be removed            |
| Discuss and assign                 | Issue discussion → Assign to → select member → Send and assign                                                              | Selection alone does not submit; without text the action is Assign; Keep current preserves assignee                |
| Manual work                        | Update progress/completion using the status selector; communicate explanations and results through comments and attachments | Ordinary properties autosave; discussion assignment submits with Send, not an extra acceptance form                |
| Archive Issue                      | Details → More information → Archive issue → Confirm archive                                                                | Archival, not permanent deletion; check subtasks/linked runs and do not assume success if stopping execution fails |
| Restore Issue                      | Project board → Archived → Restore; Load more for further entries                                                           | Different from archived runtime conversations in global settings; project visibility still applies                 |

## Individual code-project menu operations

Hover **left sidebar → Projects → project** and select …, or right-click the project. This menu manages a code project, not a project-space board's settings.

| Feature                   | Steps and effect                                        | Conditions or limitations                                                                              |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pin/unpin project         | Toggle in the menu to organize frequently used projects | Requires available project state and owning device                                                     |
| Edit/rename               | Open the corresponding action, review fields and save   | Editable fields depend on source; renaming does not move code                                          |
| Change project appearance | Use the appearance action to cycle project styling      | Not the global theme setting                                                                           |
| Reveal in file manager    | Choose Finder/system file manager                       | Requires an accessible local path                                                                      |
| Create permanent worktree | Select the action and complete its dialog               | Requires a supported Git source; differs from a temporary task worktree eligible for automatic cleanup |
| Archive all chats         | Review the confirmation scope before submitting         | Archives project conversations, not the repository                                                     |
| Remove project            | Select Remove and review confirmation                   | Handle uncommitted work and linked worktrees first; removing a record is not a backup                  |

For project-space Issues, open **top + → Collaboration → project**, then use the board view menu, Issue details or project settings. Role and visibility rules govern available actions. The following sections explain individual fields and workflows.

Projects group conversations that use the same codebase. A project can map to folders on one or more execution devices.

## Existing folders and Git projects

When the project list is empty, the sidebar's **Projects** section shows **+ New project** directly. Select it to choose a **Local project** or **Cloud project**; cloud projects still require a cloud connection. Wework hides this empty-state action while project data is synchronizing so an unfinished load is not mistaken for an empty list.

Choose **Local project** to open the system folder picker. Select an already registered project directly rather than adding it again. Registered entries survive refresh/restart and are not hidden merely because their source is inside a `Codex` directory.

In local mode, choose **Local project** and select one or more folders in the system directory picker. This entry always uses the local execution device, even when cloud or remote devices are connected. To use another device, choose **Cloud project**, then open an existing directory, create a blank project, or enter a Git repository URL to clone on the target device. Git projects use the repository name as the directory name by default and allow an optional branch and target parent directory. After submission, the dialog closes immediately and the project list shows clone progress; failed clones can be retried or dismissed there.

<a id="add-device-from-project"></a>

After choosing **Cloud project**, select **Add device** beside the remote host picker. If no device is available, the dialog opens the add-device flow directly. The choices match **Settings → Personal → Cloud connection → Add device**. You can create a cloud device managed by Wegent or generate a startup command for a remote Docker device you manage. When the new device is online and version compatible, the project dialog selects it so you can open or create a directory.

In the cloud-project creation dialog, **Use existing folder** and **Create**
also open the system directory picker when the selected execution device is
the current Wework machine. Cloud and remote devices continue to use the
in-app directory picker because their directories must be read and created by
the selected device. Desktop automation keeps the controllable in-app picker
so CI can verify the flow reliably; ordinary Wework sessions do not use that
automation compatibility path.

The local create-project dialog uses the first source folder's name as the project name by default; you can edit the name or add and remove source folders before confirming. Wework saves the folders as one Codex project and uses the first folder as its default workspace. The project list keeps one project row instead of expanding every source folder. Use **Edit project** from the project menu to rename the project, add or remove source folders, or change the primary folder. Multi-folder creation currently applies only to local Codex projects; cloud and remote projects are still added one folder at a time.

If a connected cloud device and the current local Wework executor refer to the same workspace, adding that folder as a local project merges the local and cloud records into one project row. Wework matches the executor identity, normalized workspace path, workspace kind, and worktree. The project remains deduplicated after Wework restarts, and existing cloud tasks continue to appear under the merged project.

To create a Git project, select a device, repository, default branch, and destination. If repositories are unavailable, check the Git connection and token permissions in Settings.

## Select and create branches

Use the branch menu in the composer to search and switch local branches, or create and check out a new branch. The list excludes tags and remote-tracking refs and places the current local branch first. Branch listing and current-branch queries use commands compatible with older Git versions, without depending on `git branch --format` or `--show-current`. A detached HEAD has an empty current branch name; local branches remain selectable.

Selecting a branch performs checkout on the execution device even when its name matches the last displayed branch, so cached UI state cannot prevent recovery from detached HEAD.

Pushing also uses a current-branch query compatible with older Git versions. Check out a branch before pushing from a detached HEAD.

If another device still reports `unknown option`, confirm that its Wework executor has been updated. Cloud connections to cloud or remote devices also require an updated Wegent Backend. Git queries run on the device that owns the workspace; updating Git on another machine does not change that device's queries.

## View pull request and merge request status

When a task is opened or selected, Wework reads the branch, remote URL, PR/MR status, and change counts concurrently. It displays the PR/MR status as soon as that lookup finishes instead of waiting for a slower diff count; changed-file and line counts update independently afterward. These Git queries do not start the user's login shell, so shell startup scripts, SDK initialization, and other personal environment configuration cannot block the environment panel.

During a manual environment refresh, Wework keeps the previous change statistics for the same device and workspace until the new diff statistics are ready. Intermediate branch or PR/MR results therefore do not briefly reset the counts to zero. Switching to another device or workspace does not reuse the old statistics.

For tasks using a GitHub or GitLab workspace, the environment panel looks up the pull request (PR) or merge request (MR) associated with the current branch. The request number and title stay on one line. The main icon color communicates the open, closed, or other request state, while a small lower-right icon shows checks pending, passed, or failed. A red merge-conflict icon takes priority over the check result when conflicts exist. After a GitHub PR enters the merge queue, Wework shows a yellow **In merge queue** waiting icon even when all branch checks have passed, until the PR leaves the queue or is merged. When a new commit is pushed to the same PR after a Merge Queue failure, Wework ignores historical failure events older than the current head commit and shows the new commit's check status. When a GitHub workflow check has multiple runs, Wework uses the latest result so a superseded cancelled or failed run does not override the current status. Select the status icon to open its action menu. Selecting outside the menu, pressing `Esc`, or choosing an action closes it. Choose **Open PR/MR** to open the request in your browser.

The task list in the left sidebar, project-space board, and right-side environment panel reuse the same PR/MR monitoring snapshot, status priority, and icon for a task. Failed checks, merge conflicts, Merge Queue states, drafts, closed requests, and merged requests update consistently in all three places. The environment panel also stops showing an old PR/MR after the shared monitor confirms that the current branch has none.

The shared monitor is the only owner of PR/MR status queries. The environment panel loads branch and diff information separately and does not start a second status lookup. Tasks from the same repository are grouped into one batch query, and rebuilding the runtime task list with equivalent task objects does not immediately repeat that query. Status still updates on the monitor interval, manual refreshes, and explicit refreshes after commits or pushes. Structured states such as a missing CLI, missing authentication, or lookup failure flow through the same snapshot to every surface.

The lookup runs in the task's actual workspace on its execution device: GitHub uses `gh`, and GitLab uses `glab`. In a single-machine Wework setup, the local executor runs the command directly, so a separate cloud Git service connection is not required. Install and authenticate the corresponding CLI on that machine:

```bash
gh auth login
glab auth login
```

Open **Settings → Git hosting** to inspect whether local `gh` and `glab` are installed and authenticated, open their installation guides, or copy the login commands. The page also provides a **Show PR / MR status** switch. Turning it off stops status lookup commands while keeping the create PR/MR action available. Wework reads CLI status only and does not store access tokens.

When `glab` has multiple GitLab instances configured, the settings page reports the GitLab CLI as **Ready** if at least one instance authenticates successfully; an expired or unauthenticated instance does not hide another usable instance. MR lookup for a specific repository still selects the GitLab instance from that workspace's Git remote, so the repository's own instance must also remain authenticated.

If the current branch has no PR or MR, the environment panel continues to show the create action. The create action also remains available when the CLI is missing, unauthenticated, or temporarily fails, together with a relevant recovery hint. Wework refreshes the environment after commit-and-push or push, and reopening the environment panel queries the latest status again.

## Link a project space

After enabling **Settings → General → Experimental features**, open **Edit project** for a local project and configure **Automatically join project space**. A local project is the code and execution workspace, while a project space is the task-tracking and collaboration board. Linking them does not move or copy project files, and neither resource replaces the other.

### Create a local or cloud project space

The Collaboration page always shows the current device's **Local space** in
the sidebar. When it is empty, the guide offers **Add folder**. After you choose
a directory and confirm the project name, Wework registers it as a Task project
and adds it to the local space. Cloud projects are still created inside a cloud
space, and the creation UI identifies the actual storage location:

- A **local project** is stored on the current device and is available only on that device.
- A **cloud project** is stored in Wegent Cloud and supports collaboration across devices signed in to the same account. Selecting it while signed out starts the sign-in flow. If the account has no cloud space after sign-in, Wework creates one before continuing project creation.

While creating a cloud space, the button shows **Creating…** and prevents duplicate
submissions. If creation fails, the dialog displays the error and keeps your input
so you can edit it and retry. A successful save opens the new space or continues
the project creation you started earlier.

The storage location cannot be changed after the project is created. The task source (built-in tasks, GitHub, or GitLab) controls where task data is read from; it does not change whether the project is stored locally or in the cloud.

### Create a cloud collaboration project from a template

Choose a template through **Discover templates** when creating a project. Bundled Agents use the current device and its default model. The device must be online and accessible to the signed-in account; importing into an existing project also requires a device grant for that project. Historical offline records for the same desktop neither block creation nor become execution targets.

If the current execution device is unavailable, check its cloud connection and use permissions. If multiple online records match the same desktop, resolve the execution-device ambiguity before continuing.

After selecting a template, creation waits for the execution-device list to finish loading. If loading fails, the execution environment section shows the error and a **Retry** action; creation becomes available after a successful refresh.

### Configure local project collaborators

Wework automatically maintains a **Current device agent** in the local space, so users do not need to create an agent first. A new local project includes **Me** and the **Current device agent** by default. You can remove the agent before creation or add it again through **Add collaborator**. Creating a project does not automatically create a collaboration group.

When two or more agents are selected, the creation flow recommends organizing them into a collaboration group. After confirming, choose a generation model and optionally add collaboration instructions in the task composer. Wework progressively generates the leader, member responsibilities, assignment principles, and suggested workflow. You can edit the result before saving and update it later in project settings.

### Use workspace agents in a project

After creating or adding an agent under **Project settings → AI team → Agents**, an administrator can select it under **Assignee → Workspace agents** on a new or existing Issue. Assignment executes according to project configuration. Use **Add agent → Existing agents** on that settings page to enable it beforehand. Catalogs show the configured display name or the resource name when no display name is set.

Local spaces save the agent configuration in the project, preserving its resource name, display name, model policy, and tools. In cloud spaces, workspace sharing grants use permission, while a project binding determines where the agent is available. Sharing does not grant permission to edit its source definition. Execution still requires an authorized project device and model.

<a id="agent-capabilities"></a>

### Agent capabilities and disabled state

Open **Project settings → AI team → Agents → Edit** on the relevant entry. Template-imported and manually created Agents use the same editing entry in both local and cloud projects. The Edit action requires permission to edit the Agent definition; shared use permission does not grant editing permission. Click **Save** to apply changes and refresh the project list. A failed write keeps the form open with its values and an error. If the write succeeds but refreshing the list fails, the editor closes and the list offers a retry that only reloads data. Saving other fields preserves untouched routing; older Agents do not need a model-policy upgrade first.

In a global, space or project agent create/settings form, check resource ownership and choose the capability source:

| Option/action                       | Steps and limits                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow runtime device (recommended) | Uses that running device's current user's plugins, Skills, MCP and local capabilities; today's device preview is not a guarantee for a different device               |
| Fix capabilities to Agent           | Search/add/remove plugins and Skills to store them with the agent; plugin capability selection is Codex-only and configured capabilities synchronize before execution |
| Advanced MCP                        | In fixed mode, edit MCP JSON in advanced settings and check format/source trust; do not put credentials in prose or chat                                              |
| Prompt references                   | Plugin/Skill references require fixed capabilities and lock required selections; review/remove the reference before changing its required item                        |
| Save                                | Explicitly save after reviewing capabilities, execution environment and model; choosing an option alone does not save                                                 |
| Disable                             | Disabling in project agent configuration submits immediately, without another confirmation dialog; not deletion of the source agent or termination of an existing run |
| Share and re-enable                 | Restore a disabled project entry after checking its sharing scope; this both re-enables it and shares it with the space                                               |
| Remove from space                   | Removes the space association, not a project's Disable action or deletion of the source resource                                                                      |

### Add and create Agents

When adding an Agent, search existing Agents by name or owning space, or open
the creation form. New Agents default to **Automatic selection** for execution
and the first available cloud model. The basic tab shows the current environment
and model in its footer, so you can create the Agent without opening runtime settings.

Open **Runtime settings** to change these defaults. The environment menu lists
automatic selection, selection at run time, and specific devices, with project
shared devices before personal devices. Search by name or device ID. Only online
devices appear initially; use **Show offline devices** in the bottom-right corner
to include other devices. Native models are added only after selecting a specific
device. Editing an existing Agent preserves its saved choices.

Cloud model requests end after 10 seconds and release the pending cache entry,
so refreshing starts a new request. You can still select and save a cloud model
while device-native model discovery fails or remains pending. Collaboration groups
load their member list independently. A member loading failure offers a retry;
loaded groups, Agents, and group saves remain available.

Basic project settings initially show project properties. Expand **Tags** to load
task tags, with retry on failure. Once loaded, tags used by tasks remain manageable;
renaming or deleting a tag also updates the affected tasks.

### Set cloud board access

Cloud projects have two access modes: **Private** and **Public**. A public project grants every signed-in user the Viewer (read-only) or Developer (create and edit issues) role. A private project is available only through existing grants. Project roles are Owner, Maintainer, Developer, and Viewer. Owners manage the project and members; Maintainers can also manage issue security. Developers and above can assign the issue owner, and the issue creator can always assign their own issue.

Issue visibility is set separately during project creation, in project settings, and on each issue. Choose whether new issues default to **Visible to project members** or **Related people only** when creating the project; Maintainers can change the default or individual issues later. Owners and Maintainers see every issue. Other users see open issues and issues related to them: issues they created, are assigned to, collaborate on, have an active execution task for, or that are assigned to a robot they created. Unrelated issues are omitted from boards, tables, execution lists, and project conversations. Opening one directly returns not found.

DingTalk controls access to AI Table records. Wework project roles control entry and editing in its table view.

### Import more projects into the local space

Wework automatically adds local Task projects to the local space during initial
setup. To add more projects later, open the local space's **…** menu or the
project page's **Add project** menu:

- **Import existing project** lists projects that already exist on the Tasks
  page but are not yet in the local space. Wework deduplicates them by runtime
  project identity and normalized workspace roots, so projects already shown in
  the local space are excluded.
- **Add folder** selects a new local directory, registers its Task project, and
  adds it to the local space immediately.

Background synchronization does not automatically restore an archived local
collaboration project, preventing a project the user removed from reappearing.
Explicitly choosing its Task project from **Import existing project** restores
the corresponding local collaboration project. The sidebar refreshes after the
import, and restarting Wework does not create a duplicate.

New conversations started in that local project inherit the selected project space. Before the first message is sent, the composer shows **Add to board · Project space name**. Sending creates a task in the selected local or cloud project space and links the conversation. Repeated synchronization of the same conversation does not create duplicate board tasks.

The default project space belongs to the local project's settings and is stored with that project's device-local state; the project space does not keep a reverse link. Use the composer's **+** menu to select, replace, or remove the project space for an individual conversation before sending.

Project-space lists, default-space selection, and current-task links are resolved in the background. The composer, image and file paste, attachment upload, and message sending remain available while a lookup or link is pending. Wework adds the project context or completes the task link after the result arrives instead of blocking the conversation with a linking state.

### Initialize the project execution environment

Creating and manually handling an issue does not require an initialized execution environment. Starting an AI execution task requires the project's execution environment to be initialized on at least one online device. If the collaboration home reports that the environment is not initialized, choose **Configure execution environment**, initialize an available device in project settings, and then return to the issue to continue execution.

After initialization, the collaboration home reads the latest project configuration and device status again; reloading the page or reopening the project is not required. If the device is marked complete but the warning remains, confirm that the device is still online and reopen the execution-environment settings to check the initialization result.

## Board quick start

You can create an issue even when no device has been added, the device is offline, or the environment is not initialized. Creating an issue does not redirect to execution environment settings. Manual work can continue; configure the environment when AI execution is needed.

The first time an empty project-space board is opened, Wework shows a collapsible three-step guide above the existing board:

1. Create the first issue. Choose the **Build feature**, **Fix problem**, or **Research proposal** template to start with a useful description structure.
2. Open the card details to review its description, owner, execution progress, and deliverables.
3. Drag the card from **Inbox** to **Ready** and confirm that the board action updates its status.

Each completed step is marked automatically, and the guide hides after all three steps are complete. Choose **Collapse** to reduce its footprint temporarily, or **Don't show again** to disable it for the current user and project space. Boards that already contain items do not interrupt users with this first-run guide.

Empty columns also explain what belongs in each stage and name the creation action that is currently available. During a drag, the destination column describes the resulting status. The default **My tasks** board uses task terminology, while other project spaces continue to use issue terminology.

## Save and switch board views

The native task board's view dropdown on the right provides switching, creation, and board settings on the same toolbar as **Focus view** and **Archived**. The base board groups Issues by the five default statuses: Inbox, Pending, In progress, In review, and Completed. Status and custom tags remain separate Issue properties.

Project administrators can save multiple views, bind each lane to a status or tag, reorder lanes, configure tag filters, and choose the project default view. Entering a project opens its default; subsequent switches apply to the current visit. Views and their default are shared with project members. Deleting the default view restores the base board. Lane settings and card fields are edited in one dialog and saved together; card fields apply to every view in the project.

Add an **Other (unmatched)** lane, name it **Backlog**, and move it to the left. Each view supports one such lane. It displays Issues within the view filters that match none of the other status or tag lanes. New unmatched Issues appear automatically, including those with unrelated business tags. Dragging back removes all stage tags bound by this view while preserving other tags and status. If the status still matches another status lane, change the status first. A return that would violate the view filters is also blocked. The lane’s create action keeps the normal initial status and supplies tags satisfying the view filters. The action is hidden when that status matches another lane or the filters cannot be satisfied.

Tag names allow up to 32 Unicode code points, including supplementary characters such as emoji. Stored names have no leading or trailing whitespace; lanes and filters must reference the same canonical names. Issue tags, project tags, tag lanes, and filters use the same length limit. Longer input displays an error and cannot be saved; names are never automatically truncated. Historical long tags retain their original values when read or when unrelated fields such as titles change.

Each Issue and the tag catalog saved in project settings allow up to 20 distinct tags. Dragging an Issue with 19 tags into a new tag lane adds its twentieth tag. Adding another tag at the limit displays an error, preserves the original tags and version, and shows no success feedback. Replacing a tag between two tag lanes remains available. Tag lists are never automatically truncated; historical lists above the limit remain intact when read or when unrelated fields change.

Renaming or deleting a tag in a native project saves the catalog, tags on undeleted Issues, lane bindings, and filter references together. A project version conflict or any Issue update failure rolls back the entire operation so it can be retried after resolving the error. Externally hosted Issues do not support this transaction across records. Failed bulk status changes in the table list the affected Issues and reasons; successful Issues are deselected while failed Issues stay selected for retry.

| Drag direction  | Issue changes                                                                  |
| --------------- | ------------------------------------------------------------------------------ |
| Status → Status | Update status and keep tags                                                    |
| Status → Tag    | Add the destination tag and keep status                                        |
| Tag → Status    | Update status and keep tags                                                    |
| Tag → Tag       | Remove the source tag, add the destination tag, and keep other tags and status |

An Issue can appear in both its matching status and tag lanes. After a cross-type drag, the destination card is highlighted and feedback describes the actual change. Dragging into a tag lane never reopens a completed Issue. Custom views with In progress or In review lanes also support Focus view to expand execution progress.

Existing projects keep the base board without converting historical Issue statuses or tags. Concurrent configuration changes produce a conflict message and refresh the latest configuration. Older clients cannot edit unknown view formats created by newer versions.

## Quick tag filters

Choose **All tags** in the board toolbar, type to find tags, and select one or more.
An Issue matches if it contains any selected tag. The filter preserves lane grouping
and combines with board search and saved-view conditions. Clear the selection to show
all tags; switching projects or views resets it. Filtering does not change shared views.

## Edit Issue properties

Tags, status, priority, assignee, parent, date range, and milestone save immediately
for existing Issues. Press Enter or leave the title field to save a title change.
Type in the milestone picker to search; choose **Not set** to remove its association.
New Issue properties are still submitted together when creating the Issue.

Only the description requires **Save**. Saving properties never submits an unsaved
description, and cancelling description editing does not revert saved properties.
Failures display an error and a retry action. Consecutive changes are saved in order;
submitted changes continue to finish after leaving the detail view.

## Sub-issue progress on cards

Issue cards with sub-issues show a progress ring and **Sub-issues 2/5**, meaning 2 of 5 direct sub-issues are completed. The ring turns green when all are complete. Select this control to enter the Issue's sub-issue board without opening its details.

Progress counts direct sub-issues that the current user can view and that are not archived. It excludes deeper descendants and is independent of search, tag filters, and grouping. The control is hidden when no eligible sub-issues exist. Local and cloud projects share this presentation.

Desktop regression: `pnpm --filter wework e2e:desktop --segment collaboration-parent-board`. The new progress checks share the existing parent-board CI checkpoint and desktop runtime.

## Lane sorting

Each lane on a native project-space board has its own **Sort by** control and defaults to highest priority first. Add ascending or descending rules for priority, creation time, and update time, then move rules up or down or remove them. Rules apply from top to bottom: each subsequent rule breaks ties, and manual order breaks any remaining ties. Choose **Manual order** to reorder cards within status, priority, assignee, or tag lanes, or insert a card into another lane at a specific position. Non-status lanes can mix Issues with different statuses; reordering within a lane preserves status, assignee, and tags. Manual positions use the project’s shared order across groupings. Preferences are saved on the current device by user, project space, grouping, and lane, are restored when reopening the board, and do not affect other members. Drop onto the blank space at the end of a lane to append a card. Group fields and position are saved together; a failed save commits neither. Changes to different lane preferences in multiple windows are retained independently and synchronized to open boards.

Desktop sorting regression: `pnpm --filter wework e2e:desktop --segment collaboration-board-sorting`. This independent checkpoint runs in Core CI against the real cloud backend and local SQLite, covering default priority, independent compound lane rules, restoration after window reloads, rejected within-lane reordering under automatic sorting, and persistence of manual drags and cross-lane moves.

Post-save refresh recovery regression: `pnpm --filter wework e2e:desktop --segment collaboration-board-move-recovery`. This independent Core CI checkpoint uses a real Developer member with three visible Issues interleaved with hidden siblings. It verifies backward moves, visible order after interrupted snapshot delivery, recovery on reload, and fields and ordering across concurrent moves and out-of-order snapshots. The test faults only transport of real backend responses and verifies that hidden Issues remain invisible.

## Calendar, Gantt, and table views

Use the project-space header to switch among **Board**, **Calendar**, **Gantt**, and **Table**. Issue details use one date-range control for the start and end dates. If only one date is set, Calendar and Gantt treat the issue as a one-day task.

- **Calendar** displays tasks by month, week, or day. Multi-day tasks use continuous bars; when a task crosses a week boundary, each row keeps its outer spacing and continues on the next row. Dragging any segment moves the whole task and highlights the destination dates. Calendar does not expose separate start or end resize handles.
- **Gantt** displays a week, month, quarter, or year timeline. Drag the whole bar to reschedule a task while preserving its duration. Hover the bar and drag either edge to change only the start or end date. Unscheduled tasks appear below the timeline and can be dragged onto a date.
- **Table** shows title, status, assignee, tags, start date, end date, execution state, and updated time by default. Issue IDs and assignment sources are hidden by default. Select a sortable header to toggle ascending and descending order; status, assignee, and tag headers provide filters. Selecting multiple rows enables bulk status changes and bulk archive, while a single-row archive uses an icon action.

Calendar and Gantt filters, grouping, and sorting are first stored as personal settings on the current device. Choose **Restore project settings** to discard personal changes. Members with project-management permission can choose **Save as project settings** so other members open the project with the same defaults.

## Execution environment in Project settings

In a collaboration project, open **Project settings → Execution environment** to add a repository and initialize an execution environment when needed. A project without a repository can use a blank workspace. Normally, selecting a repository or entering its Git URL is enough: the name and directory are derived automatically. Expand **Advanced options** only to customize the name, directory, or branch. Setup steps are optional; no placeholder fields are required to save the configuration.

Manual work does not require execution-environment initialization or an extra form. Choose status or assignee in Issue details; property changes save independently of unsaved description. See this page's [project operations](#project-controls) for discussion assignment, archive and restore.

## Message AI

Select the always-visible **Ask AI** button on the right of the board to expand its conversation sidebar. The **New conversation** icon next to a project in the collaboration sidebar also opens it. No collaboration group, AI leader, or experimental feature is required. Both local and cloud projects are supported. New conversations run on the current computer with the current project board as their default context, subject to the user's actual access and execution permissions.

The board filter toolbar adapts to its pane's available width. In a narrow pane, grouping, group-value, tag, milestone, parent-row, and Ask AI controls collapse to icons, and the search field becomes shorter. This also applies when the conversation sidebar is open. Hover or keyboard-focus an icon for its full label; filtering and switching behavior stay unchanged.

Send a message directly without selecting another project or working directory. The sidebar header identifies the current project. Start new conversations, switch between existing conversations, or reopen the sidebar and choose a previous conversation to continue it. Local and cloud project histories are kept separate. If the local execution environment is unavailable, the sidebar reports the error; send again after recovery.

Opening a conversation does not enable background project coordination. For work that needs a tracked owner, status, and deliverables, create a board task and assign a member, robot, or collaboration group.

## Issue details and execution tasks

Opening an issue from a project-space board shows its attachments directly in the detail panel, with actions to download, remove, or upload more files. The attachment section uses the same dividers and spacing as the other detail fields, and the complete row containing the file name and size downloads the file. A download shows progress; if it fails, the attachment remains available, an error is shown, and the row can be selected again to retry. The detail view keeps each file name and size visible instead of showing only an attachment count, so the context can be checked before execution starts.

Selecting **New task** in the issue detail opens the task conversation sidebar on the right. Describe the work in the composer and send it to create and link the execution task. Wework keeps this input step even when the issue is already **Pending** and never starts an empty task directly.

Comments in the issue activity have two different execution semantics:

- Sending a new top-level comment from the bottom composer creates a separate execution task from the issue title, description, attachments, and current project configuration. The new task can read the issue context, but it does not automatically inherit another execution task's conversation history.
- Selecting **Reply** inside an execution activity continues the original execution task and model session owned by that activity. Use it to add requirements, ask follow-up questions, or request corrections without creating another parallel task.

The **Execution tasks** section lists these independent tasks separately. An increased task count normally means that a new top-level comment was sent; a thread reply adds another turn to the original task instead.

For ordinary linked tasks, the Executor writes the issue's execution status from the runtime lifecycle. The board and the issue summary above the task composer do not write status independently. When the same task starts another turn or reaches a terminal state, they use the lifecycle transition as an invalidation signal and read the issue again, so an already-open board moves the issue between columns such as **In progress** and **Pending review** without a manual reload. For collaboration groups, the manager agent evaluates member outcomes and changes the issue status.

Use the UI's archive action for an unneeded Issue from its board card, table row or details' More information entry. Review subtasks and linked runs first; failure to stop a run means that merely submitting the request is not successful archival. Restore from the project's Archived list. Archival is not permanent deletion.

## Project-space files

The **Files** tab in a project space shows shared files and delivery snapshots together. Shared files support upload, folder creation, rename or move, delete, and open; delivery files can be edited in the corresponding Issue’s delivery details. Select the preview action next to any shared file, delivery snapshot, or local task attachment to open it in the reusable workspace file preview panel on the right. The original download or open action remains available.

Local and remote project spaces share files differently. Local project spaces aggregate attachments sent by users and generated by AI during task conversations into the **Task attachments** area by default. Remote project spaces do not expose raw task attachments; files appear in the project-space Files tab only after a task is completed and explicitly delivered. Remote delivery does not include the entire conversation by default. Select the chat messages, conversation attachments, and local files or folders that should be included in the snapshot.

When another member assigns you a board task in a cloud project space, a Wework desktop app that is connected to that cloud and allowed to send system notifications displays a system notification. Reassigning the same owner or assigning a task to yourself does not send another notification.

## Project space automation

Project space boards include an **Automation** tab that manages robot members and the execution queue together.

### Robot members

Members with project permissions can add robots (AI members) and configure each robot's name, model, system prompt, visibility, execution environment (local or cloud), and execution mode. Tasks assigned to a robot are executed automatically by that robot.

### Execution queue

The execution queue shows waiting and running tasks in columns:

- **My tasks**: tasks assigned to the current user that are not finished yet.
- **One column per robot**: tasks assigned to that robot.

The queue can be filtered by execution state (pending approval, queued, claimed, running, failed) and searched by title; running tasks show a spinning status icon. Robots configured for manual approval put their tasks into the pending approval state until a member approves them.

### Automatic PR repair

Under **PR automatic repair** in the **Automation** tab, choose which abnormal states should continue the original task and ask AI to repair the change request. Supported triggers include failed checks, merge conflicts, Merge Queue failures, Merge Queue timeouts, and Merge Queue conflicts. An optional instruction can be appended for the AI. The configuration is stored with the project space and can be changed by members with project-management permission.

Automatic repair reuses the PR/MR monitoring state shown on the board and in the task sidebar. A trigger continues the linked task conversation rather than creating a replacement task, and a closed PR or MR does not trigger repair. The task's execution device must be online, and its `gh` or `glab` CLI must be able to read the repository.

### Automation rules and AI management

Automation rules can run on a schedule or be triggered by project events such as task creation and by webhooks. Rules can be enabled or disabled, run immediately, inspected through their run history, and cancelled while unfinished. Scheduling runs on the server, so the Wework client does not need to remain online.

When a collaboration group handles an issue, its manager agent always reads the issue and eligible members before creating a workflow plan. The manager writes a specific execution prompt for each child task; members receive that assignment prompt rather than the static role description in group settings. After members report their outcomes, the manager decides whether to continue work, request review, or complete the issue. This flow does not depend on preset stages or a collaboration-mode option.

Issue activity describes assignments as “Project manager assigned ‘Task title’ to Member” without repeating a manager role label. When a linked execution is available, select **View execution** to open its details.

Each rule selects one assignment strategy:

- **Manual selection** fixes one project robot. When the rule fires, the original board task is assigned directly to that robot through the same execution flow used by an ordinary human assignment.
- **AI managed** lets an AI manager use a restricted MCP to read the original task and the capability descriptions of currently available project members and project robots, then directly assign the best candidate. If none is suitable, the task stays unassigned. The manager never executes or owns the original task; its final text is an audit record and is never parsed as an assignment.

AI management supports two manager sources. **Custom AI** selects a model and a local or cloud Wework device and uses the existing Wework runtime transport with exactly three MCP operations: read the task, list assignment candidates, and assign the task. **Wegent agent** uses an accessible, fully configured Wegent agent; the Backend creates a standard Task/Subtask and provides an equivalent MCP scoped to the current project, task, and automation run. If a project robot is selected, that robot is the business-task executor; if a project member is selected, automation only changes the assignee.

After a robot is selected, automation calls the same board-assignment path as a person. The robot keeps its current model, device, code workspace, and execution mode. Local work stays **Queued** while its device is unavailable and is claimed when Wework reconnects; the Backend dispatches cloud work. Execution records do not store model credentials; runtime configuration is resolved when execution starts.

The manager's decision is shown in its own parent comment. When the selected project robot starts, it creates a separate execution comment. Only the project robot's completion can move the original task to review; completing the manager decision does not complete the task.

The Automation tab is available for local, GitHub, and GitLab project spaces. DingTalk AI Table project spaces keep their data in the external table and do not show the tab.

## Create a project from the composer

Open the project selector above a new-conversation composer to create a blank project or add an existing folder. After creation, the project appears in both the sidebar and the composer and immediately becomes the workspace for the current new conversation.

If you switch to a standalone conversation, use **New conversation** on the project row to create a fresh project conversation and select that project again. Wework does not reuse the standalone conversation's input or session state.

## Regular workspaces and worktrees

- A regular workspace runs tasks directly in the project folder.
- A Git worktree gives each task an isolated branch and folder, which is useful for parallel changes.

For worktree tasks, the file tree, terminal, and development tools use the task's worktree. Commit or preserve changes before archiving the task.

## Multiple devices

A project can reference a different folder on each local, cloud, or remote device. Select the device that contains the code when starting a task. Copying a task to another device requires a project folder on that device.

On macOS, open a folder from a terminal with `wework .` or `wework /path/to/project`.

## Editing deliveries

For the initial entry, open **current task workbench → Toggle summary → Deliver / Deliver to task…**. It requires a current task and available linked-project/delivery context. If no Issue is associated, first use the summary's project-space association action; arbitrary historical messages are not a delivery entry. Inspect summary output/source items before choosing what to include in the snapshot.

Set a title and Markdown notes when delivering, and select the messages, files, or folders to include. The title initially uses the current task title.

After confirming a delivery from a task, a successful save closes the delivery dialog and opens the linked Issue's detail drawer so you can review its delivery records. If saving fails, the dialog stays open with an error so you can retry.

The delivery is saved in the project space that owns the linked Issue.

Open a delivery from its Issue and select **Edit** to change its title, notes, files, and selected messages. **Select more source messages** reads the source conversation under current access permissions. If the source is offline, deleted, or inaccessible, existing messages can still be kept or removed. Assets referenced by deliverable requirements cannot be removed directly.

**Save changes** updates the same delivery and preserves its link, source task, and initial delivery time. Editing does not complete tasks again or advance workflows. There is no version-history UI. Cancel makes no changes. Failed saves retain the form. On a concurrent-edit conflict, preserve any text you need before choosing **Reload and discard edits** to view the latest delivery.

Local projects support offline editing. Cloud projects require access to the Issue and a Developer or higher project role. The Files tab shows the saved attachments.

Desktop regression: `pnpm --filter wework e2e:desktop --segment collaboration-delivery-editing`. This independent Core CI checkpoint creates its own project and delivery and checks editing, cancellation, version conflicts, and persistence after reloading.

## Copy an Issue web link

Open an Issue in a cloud project space and click **Copy web link** in its detail header to copy its address on the connected Wegent website. The button confirms success with **Copied**; if copying fails, click again to retry. Recipients still need to sign in and have access to the project.

Local project space Issues have no corresponding Wegent webpage, so this action is hidden. It is also hidden until the cloud website address is available.
