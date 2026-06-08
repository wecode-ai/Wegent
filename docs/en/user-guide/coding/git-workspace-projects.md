---
sidebar_position: 4
---

# Git Projects

Git projects clone a remote repository into the Wework project list as a reusable project workspace. After creation, new conversations under the same project use the same local code directory, which is useful for continuous development, debugging, and validation around one repository.

## Prerequisites

- A local or cloud execution device is online.
- A Git token with access to the target repository is configured in Settings.
- The target repository and default branch are visible to the current account.
- The execution device can reach the Git service endpoint.

## Clone a Project from Git

1. In the Wework sidebar, click the create button next to “Projects”.
2. Select “Clone from Git”.
3. Choose the execution device in the dialog.
4. Select a Git repository.
5. Select the default branch.
6. Click “Create project”.

The dialog opens immediately, then loads repositories and branches asynchronously. While repositories are loading, the repository selector shows “Loading repositories...”.

## Directory Rules

Git projects are cloned under the execution device project root:

```bash
~/.wecode/wegent-executor/workspace/projects/<repoName>
```

For example, when the repository name is `pluto`, the final directory is:

```bash
~/.wecode/wegent-executor/workspace/projects/pluto
```

Task execution enters the same directory. In other words, the `git clone` location used during project creation and the workspace directory used by later tasks stay aligned.

## Execution Modes

In the new-conversation input area for a local workspace project, you can choose which workspace directory the task should use. The project can come from “Clone from Git” or “Using existing folder”; as long as the directory is a Git repository when the task is sent, it can use a new worktree.

- “Local workspace”: the task enters the project-bound directory, such as `projects/<repoKey>/<repoName>` or an existing folder selected by the user.
- “New worktree”: before sending the new task, Wegent runs `git worktree add` on the same execution device and creates a dedicated worktree for that task.

New worktrees are created under the execution device workspace root:

```bash
~/.wecode/wegent-executor/workspace/worktrees/<taskId>/<projectName>
```

The worktree ID is the task ID. The task stores only `git_worktree` as the execution workspace source; the actual path is derived from the task ID and project directory rules when executing or managing worktrees. Branch name, base ref, the original checkout path, and the absolute worktree path are not duplicated as task fields. The worktree settings page lists created worktrees by scanning the `worktrees` directory on each execution device. When a worktree is deleted, Wegent removes the corresponding worktree directory and soft-deletes the task that uses it.

“New worktree” is available only for new conversations in projects bound to a local execution device and local directory. Existing tasks lock the execution directory so a task cannot switch workspaces midway. If the directory is not currently a Git repository, sending the task shows an error; after the user manually turns that directory into a Git repository, no project configuration change is needed before selecting a new worktree again.

## Existing Target Directory

If the target directory already exists, Wegent does not create a new directory and does not try to reuse or overwrite the existing one. The UI displays a project-directory-exists message.

How to proceed:

- If the old directory is no longer needed, delete or rename it on the execution device, then create the project again.
- If you need to keep the old directory, choose another repository or adjust the directory name first.
- If the directory already contains the same repository, handle it manually first; Wegent does not automatically switch branches or pull updates.

## Troubleshooting Git Clone Failures

Check the project root on the execution device:

```bash
echo "$WECODE_HOME"
echo "$WEGENT_EXECUTOR_PROJECTS_DIR"

ROOT="${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}"
ls -la "$ROOT"
```

Then verify the repository and branch from that root:

```bash
cd "$ROOT"
git ls-remote --heads <git_url> <branch>
git clone --branch <branch> --single-branch <git_url> <repoName>
```

Common causes:

| Symptom                           | Likely cause                                        |
| --------------------------------- | --------------------------------------------------- |
| Authentication failed             | Git token is missing, expired, or lacks permission  |
| Repository not found              | Repository URL is wrong or the account lacks access |
| Remote branch not found           | Selected default branch does not exist              |
| destination path already exists   | Target directory already exists                     |
| Could not resolve host or timeout | Execution device cannot reach the Git service       |
