import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'
import { issueHumanInteraction } from './issueHumanInteractions'

export function useIssueHumanInteractions(
  services: WorkbenchServices | undefined,
  cached: RuntimeInteraction[]
) {
  const cloud = services?.issueHumanRequestsApi
  const local = services?.localIssueHumanRequestsApi
  const [items, setItems] = useState<RuntimeInteraction[]>(() =>
    cached.filter(item => item.sharedRequest)
  )
  const generation = useRef(0)
  const sequences = useRef(new Map<string, number>())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [resolved, setResolved] = useState<RuntimeInteraction[]>([])
  const itemsRef = useRef(items)
  const previousApis = useRef({ cloud, local })
  itemsRef.current = items
  const refresh = useCallback(
    async (onlyStore?: 'local' | 'backend') => {
      const epoch = generation.current
      await Promise.resolve()
      if (epoch !== generation.current) return
      const previous = previousApis.current
      previousApis.current = { cloud, local }
      if (previous.cloud !== cloud || previous.local !== local) {
        const retain = (item: RuntimeInteraction) =>
          item.project?.store === 'local' ? previous.local === local : previous.cloud === cloud
        setItems(current => current.filter(retain))
        setResolved(current => current.filter(retain))
        setErrors({})
      }
      const reads = (
        [
          ['backend', cloud],
          ['local', local],
        ] as const
      ).filter(([store, api]) => api && (!onlyStore || store === onlyStore))
      await Promise.all(
        reads.map(async ([store, api]) => {
          const sequence = (sequences.current.get(store) ?? 0) + 1
          sequences.current.set(store, sequence)
          try {
            const response = await api!.inbox()
            if (generation.current !== epoch || sequences.current.get(store) !== sequence) return
            const ids = new Set(response.items.map(item => item.id))
            const removed = itemsRef.current.filter(
              item =>
                item.project?.store === store &&
                item.sharedRequest &&
                !ids.has(item.sharedRequest.id)
            )
            setItems(current => [
              ...current.filter(item => item.project?.store !== store),
              ...response.items.map(request => issueHumanInteraction(request, store)),
            ])
            setErrors(current => {
              const next = { ...current }
              delete next[`issue:${store}`]
              return next
            })
            for (const previous of removed) {
              const project = previous.project!
              // A transfer or revocation is not a resolved answer.
              const current = await api!
                .list(project.projectId, project.issueId)
                .then(result => result.items.find(item => item.id === previous.sharedRequest!.id))
                .catch(() => undefined)
              if (generation.current !== epoch || sequences.current.get(store) !== sequence) return
              if (current?.status === 'resolved')
                setResolved(items =>
                  items.some(item => item.id === previous.id)
                    ? items
                    : [...items, previous].slice(-100)
                )
            }
          } catch (cause) {
            if (generation.current !== epoch || sequences.current.get(store) !== sequence) return
            setItems(current =>
              current.map(item =>
                item.project?.store === store ? { ...item, cached: true } : item
              )
            )
            // A failed refresh preserves previously loaded questions.
            setErrors(current => ({
              ...current,
              [`issue:${store}`]: cause instanceof Error ? cause.message : String(cause),
            }))
          }
        })
      )
    },
    [cloud, local]
  )
  const discover = useCallback(
    async (localPending?: boolean) => {
      await Promise.all([
        refresh('backend'),
        ...(localPending === true || itemsRef.current.some(item => item.project?.store === 'local')
          ? [refresh('local')]
          : []),
      ])
    },
    [refresh]
  )
  useEffect(() => {
    const epoch = ++generation.current
    void discover()
    return () => {
      generation.current = epoch + 1
    }
  }, [discover])
  return { items, errors, refresh, discover, resolved }
}
