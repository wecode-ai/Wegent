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
