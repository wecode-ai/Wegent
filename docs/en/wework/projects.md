---
sidebar_position: 3
---

# Projects and workspaces

Projects group conversations that use the same codebase. A project can map to folders on one or more execution devices.

## Existing folders and Git projects

Choose **Use existing folder** for code already on the device. Adding the same folder again restores or reuses its project and conversations.

In local mode, choose **Local project** and select one or more folders in the system directory picker. This entry always uses the local execution device, even when cloud or remote devices are connected; use **Cloud project** to select a folder on another device. The create-project dialog uses the first source folder's name as the project name by default; you can edit the name or add and remove source folders before confirming. Wework saves the folders as one Codex project and uses the first folder as its default workspace. The project list keeps one project row instead of expanding every source folder. Use **Edit project** from the project menu to rename the project, add or remove source folders, or change the primary folder. Multi-folder creation currently applies only to local Codex projects; cloud and remote projects are still added one folder at a time.

If a connected cloud device and the current local Wework executor refer to the same workspace, adding that folder as a local project merges the local and cloud records into one project row. Wework matches the executor identity, normalized workspace path, workspace kind, and worktree. The project remains deduplicated after Wework restarts, and existing cloud tasks continue to appear under the merged project.

To create a Git project, select a device, repository, default branch, and destination. If repositories are unavailable, check the Git connection and token permissions in Settings.

## View pull request and merge request status

For tasks using a GitHub or GitLab workspace, the environment panel looks up the pull request (PR) or merge request (MR) associated with the current branch. It shows the request number, title, open/draft/closed/merged state, and pipeline check result. Select the entry to open the PR or MR in your browser.

The lookup runs in the task's actual workspace on its execution device: GitHub uses `gh`, and GitLab uses `glab`. In a single-machine Wework setup, the local executor runs the command directly, so a separate cloud Git service connection is not required. Install and authenticate the corresponding CLI on that machine:

```bash
gh auth login
glab auth login
```

Open **Settings → Git hosting** to inspect whether local `gh` and `glab` are installed and authenticated, open their installation guides, or copy the login commands. The page also provides a **Show PR / MR status** switch. Turning it off stops status lookup commands while keeping the create PR/MR action available. Wework reads CLI status only and does not store access tokens.

If the current branch has no PR or MR, the environment panel continues to show the create action. The create action also remains available when the CLI is missing, unauthenticated, or temporarily fails, together with a relevant recovery hint. Wework refreshes the environment after commit-and-push or push, and reopening the environment panel queries the latest status again.

## Link a project space

After enabling **Settings → General → Experimental features**, open **Edit project** for a local project and configure **Automatically join project space**. A local project is the code and execution workspace, while a project space is the task-tracking and collaboration board. Linking them does not move or copy project files, and neither resource replaces the other.

New conversations started in that local project inherit the selected project space. Before the first message is sent, the composer shows **Add to board · Project space name**. Sending creates a task in the selected local or cloud project space and links the conversation. Repeated synchronization of the same conversation does not create duplicate board tasks.

The default project space belongs to the local project's settings and is stored with that project's device-local state; the project space does not keep a reverse link. Use the composer's **+** menu to select, replace, or remove the project space for an individual conversation before sending.

## Project space automation

Project space boards include an **Automation** tab that manages robot members and the execution queue together.

### Robot members

Members with project permissions can add robots (AI members) and configure each robot's name, model, system prompt, visibility, execution environment (local or cloud), and execution mode. Tasks assigned to a robot are executed automatically by that robot.

### Execution queue

The execution queue shows waiting and running tasks in columns:

- **My tasks**: tasks assigned to the current user that are not finished yet.
- **One column per robot**: tasks assigned to that robot.

The queue can be filtered by execution state (pending approval, queued, claimed, running, failed) and searched by title; running tasks show a spinning status icon. Robots configured for manual approval put their tasks into the pending approval state until a member approves them.

### Automation rules and AI management

Automation rules can run on a schedule or be triggered by project events such as task creation and by webhooks. Rules can be enabled or disabled, run immediately, inspected through their run history, and cancelled while unfinished. Scheduling runs on the server, so the Wework client does not need to remain online.

Each rule selects one execution method:

- **Project robot** assigns the board task to an existing project robot and uses that robot's current model, execution device, and code workspace configuration.
- **Custom AI** does not create a robot resource. The rule directly selects a prompt, model, and local or cloud execution device. Wework resolves the current model configuration and credentials only when execution starts.
- **Wegent agent** selects a fully configured Wegent agent that the current user can access. The Backend creates a standard Task/Subtask and routes its bots through Chat Shell or a temporary Executor according to their Shell. This method receives a board MCP scoped to the current project and task, so it can inspect the board and assign work.

Project robots and custom AI use the existing board-assignment queue. A local run remains **Queued** while its device is offline and is claimed by Wework after the device returns; the Backend dispatches cloud runs to the device bound by the rule. Configuration is not copied into execution records. A run that has not started yet uses the current robot or rule configuration when it is claimed.

Each effective run creates an independent board task. Its parent comment carries the queued, running, completed, or failed state and receives the final result. Completed work still requires human acceptance. Every run has its own execution session, which can be continued from the task comments.

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
