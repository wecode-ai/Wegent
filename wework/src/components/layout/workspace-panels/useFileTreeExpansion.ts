import { useState } from 'react'
import { resolveFileTreePath, type FileTreeData } from './fileTreeData'

export function useFileTreeExpansion(data: FileTreeData, query: string, requested: string[]) {
  const [expansion, setExpansion] = useState({ requested, expanded: requested })
  const unchanged =
    expansion.requested.length === requested.length &&
    expansion.requested.every((path, index) => path === requested[index])
  const added = unchanged ? [] : requested.filter(path => !expansion.requested.includes(path))
  const expanded = added.length
    ? [...new Set([...expansion.expanded, ...added])]
    : expansion.expanded
  if (!unchanged) setExpansion({ requested, expanded })
  const [search, setSearch] = useState<{ query: string; values: string[] }>({
    query: '',
    values: [],
  })
  const filtered = Boolean(query.trim())
  const values = filtered
    ? search.query === query
      ? search.values
      : Array.from(data.rowsByPath.values())
          .filter(row => row.kind === 'directory')
          .map(row => row.path)
    : expanded
        .map(path => resolveFileTreePath(data, path))
        .filter((path): path is string => path !== null)

  return {
    values,
    setValues(next: string[]) {
      if (filtered) setSearch({ query, values: next })
      else setExpansion({ requested, expanded: next })
    },
  }
}
