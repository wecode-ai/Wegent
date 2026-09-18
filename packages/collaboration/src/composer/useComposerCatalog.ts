import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ComposerCatalogStore<App> {
  get(): App[]
  readSnapshot(): App[]
  publish(apps: App[]): void
  replace(apps: App[]): void
  subscribe(listener: () => void): () => void
  suppressSync(): boolean
}
export interface ComposerCatalogEvents {
  requestSync?: string
  catalogChanged?: string
}
export function useComposerCatalog<Skill, App>({
  onListLocalSkills,
  onListLocalApps,
  appsStore,
  events,
  isMenuOpen,
}: {
  onListLocalSkills?: () => Promise<Skill[]>
  onListLocalApps?: () => Promise<App[]>
  appsStore: ComposerCatalogStore<App>
  events: ComposerCatalogEvents
  isMenuOpen(): boolean
}) {
  const { requestSync, catalogChanged } = events
  const skillsLoadedRef = useRef(false)
  const skillsLoadingRef = useRef(false)
  const skillsRequestIdRef = useRef(0)
  const skillsSourceRef = useRef<typeof onListLocalSkills>(undefined)
  const appsLoadedRef = useRef(false)
  const appsLoadingRef = useRef(false)
  const appsRequestIdRef = useRef(0)
  const appsSourceRef = useRef<typeof onListLocalApps>(undefined)
  const mountedRef = useRef(true)
  const [skills, setSkills] = useState<Skill[]>([])
  const [apps, setApps] = useState<App[]>(() => appsStore.readSnapshot())
  const appsRef = useRef(apps)
  useEffect(() => {
    appsRef.current = apps
  }, [apps])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [appsLoading, setAppsLoading] = useState(false)
  const [appsLoadError, setAppsLoadError] = useState(false)
  const storeRef = useRef(appsStore)
  useLayoutEffect(() => {
    if (storeRef.current === appsStore) return
    storeRef.current = appsStore
    appsRequestIdRef.current += 1
    skillsRequestIdRef.current += 1
    appsLoadedRef.current = false
    skillsLoadedRef.current = false
    appsLoadingRef.current = false
    skillsLoadingRef.current = false
    appsSourceRef.current = undefined
    skillsSourceRef.current = undefined
    const next = appsStore.readSnapshot()
    appsRef.current = next
    setApps(next)
    setSkills([])
    setAppsLoading(false)
    setLoading(false)
    setAppsLoadError(false)
    setLoadError(false)
  }, [appsStore])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadLocalSkills = useCallback(
    (options?: { force?: boolean }) => {
      if (!onListLocalSkills) return
      if (skillsSourceRef.current !== onListLocalSkills) {
        skillsSourceRef.current = onListLocalSkills
        skillsLoadedRef.current = false
        skillsLoadingRef.current = false
        skillsRequestIdRef.current += 1
        setSkills([])
      }
      if (skillsLoadedRef.current || skillsLoadingRef.current || (loadError && !options?.force)) {
        return
      }

      const requestId = skillsRequestIdRef.current + 1
      skillsRequestIdRef.current = requestId
      skillsLoadingRef.current = true
      setLoading(true)
      setLoadError(false)
      onListLocalSkills()
        .then(nextSkills => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadedRef.current = true
          setLoadError(false)
          setSkills(nextSkills)
        })
        .catch(() => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadedRef.current = false
          setLoadError(true)
        })
        .finally(() => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadingRef.current = false
          setLoading(false)
        })
    },
    [loadError, onListLocalSkills]
  )

  const loadLocalApps = useCallback(
    (options?: { force?: boolean }) => {
      if (!onListLocalApps) return
      if (appsSourceRef.current !== onListLocalApps) {
        appsSourceRef.current = onListLocalApps
        appsLoadedRef.current = false
        appsLoadingRef.current = false
        appsRequestIdRef.current += 1
        // Keep stale apps visible while the new source refreshes.
      }
      if (options?.force) {
        // Invalidate in-flight identity so a concurrent response cannot mark
        // the forced refresh as already settled or leave loading stuck true.
        appsLoadedRef.current = false
        appsLoadingRef.current = false
        appsRequestIdRef.current += 1
      } else if (appsLoadedRef.current || appsLoadingRef.current || appsLoadError) {
        return
      }

      const requestId = appsRequestIdRef.current + 1
      appsRequestIdRef.current = requestId
      appsLoadingRef.current = true
      setAppsLoading(true)
      setAppsLoadError(false)
      onListLocalApps()
        .then(nextApps => {
          if (!mountedRef.current || requestId !== appsRequestIdRef.current) return
          appsLoadedRef.current = true
          setAppsLoadError(false)
          // A completed catalog response is authoritative, including an empty list.
          appsStore.replace(nextApps)
          setApps(nextApps)
        })
        .catch(() => {
          if (!mountedRef.current || requestId !== appsRequestIdRef.current) return
          appsLoadedRef.current = false
          setAppsLoadError(true)
        })
        .finally(() => {
          if (!mountedRef.current || requestId !== appsRequestIdRef.current) return
          appsLoadingRef.current = false
          setAppsLoading(false)
        })
    },
    [appsLoadError, onListLocalApps, appsStore]
  )

  const loadLocalMentions = useCallback(
    (options?: { force?: boolean }) => {
      loadLocalSkills(options)
      loadLocalApps(options)
    },
    [loadLocalApps, loadLocalSkills]
  )

  useEffect(() => {
    // The toolbar picker asks slash to re-publish when Vite HMR has split the
    // module singleton or the picker opened before the first publish landed.
    const onRequestSync = () => {
      if (appsStore.suppressSync()) return
      if (appsRef.current.length > 0) appsStore.publish(appsRef.current)
    }
    if (!requestSync) return
    window.addEventListener(requestSync, onRequestSync)
    return () => window.removeEventListener(requestSync, onRequestSync)
  }, [appsStore, requestSync])

  useEffect(() => {
    // Keep slash candidates aligned when the toolbar/workbench refreshes the
    // shared composer app inventory after install/uninstall.
    return appsStore.subscribe(() => {
      const next = appsStore.get()
      if (next === appsRef.current) return
      appsRequestIdRef.current += 1
      appsLoadingRef.current = false
      if (next.length === 0) {
        setApps([])
        appsLoadedRef.current = true
        setAppsLoadError(false)
        setAppsLoading(false)
        return
      }
      setApps(next)
      appsLoadedRef.current = true
      setAppsLoadError(false)
      setAppsLoading(false)
    })
  }, [appsStore])

  useEffect(() => {
    const invalidateLocalPluginCandidates = () => {
      skillsLoadedRef.current = false
      skillsLoadingRef.current = false
      skillsRequestIdRef.current += 1
      appsLoadedRef.current = false
      appsLoadingRef.current = false
      appsRequestIdRef.current += 1
      setSkills([])
      // Keep stale composer apps visible while the forced refresh runs.
      setLoading(false)
      setLoadError(false)
      setAppsLoading(false)
      setAppsLoadError(false)

      queueMicrotask(() => {
        if (!mountedRef.current) return
        loadLocalApps({ force: true })
        if (isMenuOpen()) {
          loadLocalSkills({ force: true })
        }
      })
    }

    if (!catalogChanged) return
    window.addEventListener(catalogChanged, invalidateLocalPluginCandidates)
    return () => {
      window.removeEventListener(catalogChanged, invalidateLocalPluginCandidates)
    }
  }, [appsStore, catalogChanged, isMenuOpen, loadLocalApps, loadLocalSkills])

  return {
    skills,
    apps,
    loading,
    loadError,
    appsLoading,
    appsLoadError,
    loadLocalApps,
    loadLocalMentions,
  }
}
