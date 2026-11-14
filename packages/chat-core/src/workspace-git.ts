export type WorkspaceGitDiffMode = 'branch' | 'unstaged' | 'staged' | 'commit'

/** Include remote comparison refs, excluding symbolic aliases such as origin/HEAD. */
export const WORKSPACE_GIT_COMPARISON_BRANCH_ARGS = [
  '--all',
  '--format=%(if)%(symref)%(then)%(else)%(refname:short)%(end)',
]

export type WorkspaceGitSelection =
  | { mode: 'branch'; baseRef?: string }
  | { mode: Exclude<WorkspaceGitDiffMode, 'branch'>; baseRef?: never }

const DIFF_COMMANDS: Record<WorkspaceGitDiffMode, string> = {
  branch: 'git_branch_diff',
  unstaged: 'git_diff_unstaged',
  staged: 'git_diff_staged',
  commit: 'git_diff_last_commit',
}

/** A named branch/ref operand, never a Git option or revision expression. */
export function validateWorkspaceGitBaseRef(value: string): string {
  const ref = value.trim()
  if (
    !ref ||
    ref === '@' ||
    ref.startsWith('-') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    /[\x00-\x20\x7f~^:?*\[\]\\]/.test(ref) ||
    ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  )
    throw new Error('Invalid comparison branch')
  return ref
}

export function workspaceGitDiffCommand(selection: WorkspaceGitSelection): {
  commandKey: string
  args?: string[]
} {
  const commandKey = DIFF_COMMANDS[selection.mode]
  if (!commandKey) throw new Error('Invalid Git diff mode')
  if (selection.baseRef !== undefined) {
    if (selection.mode !== 'branch')
      throw new Error('Only branch diffs accept a comparison branch')
    return {
      commandKey: 'git_compare_branch_diff',
      args: [validateWorkspaceGitBaseRef(selection.baseRef)],
    }
  }
  return { commandKey }
}

/** Preserve the PC branch command order, with the current branch first when present. */
export function workspaceGitBranches(output: string, currentBranch: string): string[] {
  const branches = [
    ...new Set(
      output
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ]
  const current = currentBranch.trim()
  return branches.includes(current)
    ? [current, ...branches.filter((branch) => branch !== current)]
    : branches
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
