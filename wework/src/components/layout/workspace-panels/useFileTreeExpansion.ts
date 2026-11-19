import { useEffect, useRef, useState } from 'react'
import { resolveFileTreePath, type FileTreeData } from './fileTreeData'

export function useFileTreeExpansion(data: FileTreeData, query: string, requested: string[]) {
  const [expanded, setExpanded] = useState(requested)
  const previousRequested = useRef(requested)
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

  useEffect(() => {
    const added = requested.filter(path => !previousRequested.current.includes(path))
    previousRequested.current = requested
    if (added.length) setExpanded(current => Array.from(new Set([...current, ...added])))
  }, [requested])

  return {
    values,
    setValues(next: string[]) {
      if (filtered) setSearch({ query, values: next })
      else setExpanded(next)
    },
  }
}
