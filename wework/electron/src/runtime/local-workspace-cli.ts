import { resolve } from 'node:path'

export interface LocalWorkspaceOpenRequest {
  path: string
  label?: string
}

export function parseLocalWorkspaceOpenRequest(
  argv: string[],
  cwd: string = process.cwd()
): LocalWorkspaceOpenRequest | null {
  const openWorkspaceIndex = argv.indexOf('--open-workspace')
  if (openWorkspaceIndex < 0) return null
  const path = argv[openWorkspaceIndex + 1]?.trim()
  if (!path) return null
  const workspaceLabelIndex = argv.indexOf('--workspace-label')
  const label = workspaceLabelIndex < 0 ? '' : (argv[workspaceLabelIndex + 1]?.trim() ?? '')
  return {
    path: resolve(cwd, path),
    ...(label ? { label } : {}),
  }
}
