export type WorkspaceGitDiffMode = 'branch' | 'unstaged' | 'staged' | 'commit'

export interface WorkspaceGitSelection {
  mode: WorkspaceGitDiffMode
}

const DIFF_COMMANDS: Record<WorkspaceGitDiffMode, string> = {
  branch: 'git_branch_diff',
  unstaged: 'git_diff_unstaged',
  staged: 'git_diff_staged',
  commit: 'git_diff_last_commit',
}

export function workspaceGitDiffCommand(selection: WorkspaceGitSelection): {
  commandKey: string
} {
  const commandKey = DIFF_COMMANDS[selection.mode]
  if (!commandKey) throw new Error('Invalid Git diff mode')
  return { commandKey }
}

export function workspaceGitCommandOutput(
  response: {
    success: boolean
    stdout: unknown
    stderr?: string
    error?: string | null
    exit_code?: number | null
    stdout_truncated?: boolean
  },
  commandKey: string
): string {
  if (!response.success || (response.exit_code != null && response.exit_code !== 0))
    throw new Error(
      [response.error, response.stderr].filter(Boolean).join('\n') || `${commandKey} failed`
    )
  if (response.stdout_truncated) throw new Error('Git output exceeded the preview size limit')
  if (typeof response.stdout === 'string') return response.stdout.trim()
  if (
    Array.isArray(response.stdout) &&
    response.stdout.every((value) => typeof value === 'string')
  )
    return response.stdout.join('\n').trim()
  throw new Error('Expected text stdout from device command')
}
