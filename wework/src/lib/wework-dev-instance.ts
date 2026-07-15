export interface WeworkDevInstanceInfo {
  title: string
  port?: string
  worktree?: string
  branch?: string
  parentTitle?: string
  parentProject?: string
  parentWorkspace?: string
}

export interface WeworkDevInstanceRow {
  key: string
  label: string
  value: string
}

function envValue(key: keyof ImportMetaEnv): string | undefined {
  return import.meta.env[key]?.trim() || undefined
}

export function getWeworkDevTitle(): string | null {
  return getWeworkDevInstanceInfo()?.title ?? null
}

export function getWeworkDevInstanceInfo(): WeworkDevInstanceInfo | null {
  const title = envValue('VITE_WEWORK_DEV_TITLE')
  if (!title) return null

  return {
    title,
    port: envValue('VITE_WEWORK_DEV_PORT'),
    worktree: envValue('VITE_WEWORK_DEV_WORKTREE'),
    branch: envValue('VITE_WEWORK_DEV_BRANCH'),
    parentTitle: envValue('VITE_WEWORK_PARENT_TITLE'),
    parentProject: envValue('VITE_WEWORK_PARENT_PROJECT'),
    parentWorkspace: envValue('VITE_WEWORK_PARENT_WORKSPACE'),
  }
}

export function getWeworkDocumentTitle(): string {
  const devTitle = getWeworkDevTitle()
  return devTitle ? `WeWork - ${devTitle}` : 'WeWork'
}

export function getWeworkDevInstanceRows(info: WeworkDevInstanceInfo): WeworkDevInstanceRow[] {
  return [
    { key: 'title', label: 'Title', value: info.title },
    info.port ? { key: 'port', label: 'Port', value: info.port } : null,
    info.branch ? { key: 'branch', label: 'Branch', value: info.branch } : null,
    info.worktree ? { key: 'worktree', label: 'Worktree', value: info.worktree } : null,
    info.parentTitle
      ? { key: 'parent-title', label: 'Parent task', value: info.parentTitle }
      : null,
    info.parentProject
      ? { key: 'parent-project', label: 'Parent project', value: info.parentProject }
      : null,
    info.parentWorkspace
      ? { key: 'parent-workspace', label: 'Parent workspace', value: info.parentWorkspace }
      : null,
  ].filter((row): row is WeworkDevInstanceRow => Boolean(row))
}
