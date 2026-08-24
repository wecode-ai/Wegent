---
sidebar_position: 3
---

# Projects and workspaces

Projects group conversations that use the same codebase. A project can map to folders on one or more execution devices.

## Existing folders and Git projects

When the project list is empty, the sidebar's **Projects** section shows **+ New project** directly. Select it to choose a **Local project** or **Cloud project**; cloud projects still require a cloud connection. Wework hides this empty-state action while project data is synchronizing so an unfinished load is not mistaken for an empty list.

Choose **Use existing folder** for code already on the device. Adding the same folder again restores or reuses its project and conversations.

In local mode, choose **Local project** and select one or more folders in the system directory picker. This entry always uses the local execution device, even when cloud or remote devices are connected. To use another device, choose **Cloud project**, then open an existing directory, create a blank project, or enter a Git repository URL to clone on the target device. Git projects use the repository name as the directory name by default and allow an optional branch and target parent directory. After submission, the dialog closes immediately and the project list shows clone progress; failed clones can be retried or dismissed there.

The local create-project dialog uses the first source folder's name as the project name by default; you can edit the name or add and remove source folders before confirming. Wework saves the folders as one Codex project and uses the first folder as its default workspace. The project list keeps one project row instead of expanding every source folder. Use **Edit project** from the project menu to rename the project, add or remove source folders, or change the primary folder. Multi-folder creation currently applies only to local Codex projects; cloud and remote projects are still added one folder at a time.

If a connected cloud device and the current local Wework executor refer to the same workspace, adding that folder as a local project merges the local and cloud records into one project row. Wework matches the executor identity, normalized workspace path, workspace kind, and worktree. The project remains deduplicated after Wework restarts, and existing cloud tasks continue to appear under the merged project.

To create a Git project, select a device, repository, default branch, and destination. If repositories are unavailable, check the Git connection and token permissions in Settings.

## View pull request and merge request status

When a task is opened or selected, Wework reads the branch, remote URL, PR/MR status, and change counts concurrently. It displays the PR/MR status as soon as that lookup finishes instead of waiting for a slower diff count; changed-file and line counts update independently afterward. These Git queries do not start the user's login shell, so shell startup scripts, SDK initialization, and other personal environment configuration cannot block the environment panel.

During a manual environment refresh, Wework keeps the previous change statistics for the same device and workspace until the new diff statistics are ready. Intermediate branch or PR/MR results therefore do not briefly reset the counts to zero. Switching to another device or workspace does not reuse the old statistics.

For tasks using a GitHub or GitLab workspace, the environment panel looks up the pull request (PR) or merge request (MR) associated with the current branch. The request number and title stay on one line. The main icon color communicates the open, closed, or other request state, while a small lower-right icon shows checks pending, passed, or failed. A red merge-conflict icon takes priority over the check result when conflicts exist. After a GitHub PR enters the merge queue, Wework shows a yellow **In merge queue** waiting icon even when all branch checks have passed, until the PR leaves the queue or is merged. When a GitHub workflow check has multiple runs, Wework uses the latest result so a superseded cancelled or failed run does not override the current status. Select the status icon to open its action menu. Selecting outside the menu, pressing `Esc`, or choosing an action closes it. Choose **Open PR/MR** to open the request in your browser.

The task list in the left sidebar, project-space board, and right-side environment panel reuse the same PR/MR monitoring snapshot, status priority, and icon for a task. Failed checks, merge conflicts, Merge Queue states, drafts, closed requests, and merged requests update consistently in all three places. The environment panel also stops showing an old PR/MR after the shared monitor confirms that the current branch has none.

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

New conversations started in that local project inherit the selected project space. Before the first message is sent, the composer shows **Add to board · Project space name**. Sending creates a task in the selected local or cloud project space and links the conversation. Repeated synchronization of the same conversation does not create duplicate board tasks.

The default project space belongs to the local project's settings and is stored with that project's device-local state; the project space does not keep a reverse link. Use the composer's **+** menu to select, replace, or remove the project space for an individual conversation before sending.

## Project-space files

The **Files** tab in a project space shows shared files and delivery snapshots together. Shared files support upload, folder creation, rename or move, delete, and open; delivery snapshots come from completed tasks and remain read-only. Select the preview action next to any shared file, delivery snapshot, or local task attachment to open it in the reusable workspace file preview panel on the right. The original download or open action remains available.

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
