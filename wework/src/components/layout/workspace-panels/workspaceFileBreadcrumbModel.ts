import { normalizeAbsoluteWorkspacePath } from '@/lib/workspace-file-contract'

export function workspaceFileBreadcrumbs(path: string, rootPath: string, isDirectory: boolean) {
  const normalized = normalizeAbsoluteWorkspacePath(path, 'Workspace file path must be absolute')
  const root = normalizeAbsoluteWorkspacePath(rootPath, 'Workspace root must be absolute')
  const windows = /^[a-z]:\//i.test(root) || root.startsWith('//')
  const comparable = (value: string) => (windows ? value.toLowerCase() : value)
  const rootPrefix = root.endsWith('/') ? root : `${root}/`
  const withinRoot =
    comparable(normalized) === comparable(root) ||
    comparable(normalized).startsWith(comparable(rootPrefix))
  const base = withinRoot
    ? root
    : (normalized.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+|\/)/i)?.[0] ?? '/')
  const prefix = base.endsWith('/') ? base : `${base}/`
  const rest = normalized.slice(prefix.length).split('/').filter(Boolean)
  const baseName = base.endsWith('/') ? base : (base.split('/').filter(Boolean).at(-1) ?? base)
  const crumbs = [
    {
      path: base,
      label: baseName,
      directoryPath: base,
      activePath: null as string | null,
      expandActive: false,
    },
  ]
  let parent = base
  rest.forEach((label, index) => {
    const child = `${parent.replace(/\/$/, '')}/${label}`
    crumbs.push({
      path: child,
      label,
      directoryPath: parent,
      activePath: child,
      expandActive: index < rest.length - 1 || isDirectory,
    })
    parent = child
  })
  return { prefix: base.slice(0, base.length - baseName.length), crumbs }
}
