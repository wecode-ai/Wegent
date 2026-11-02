import type { DiagramKind } from './diagramLayout'

export interface DiagramRequest {
  code: string
  kind: DiagramKind
  theme: 'dark' | 'light'
  plantumlServerUrl?: string
}

export interface DiagramArtifact {
  svg: string
  src: string
  width: number
  height: number
}

export type DiagramSnapshot =
  | { status: 'loading' }
  | { status: 'ready'; artifact: DiagramArtifact }
  | { status: 'error' }

const LOADING: DiagramSnapshot = { status: 'loading' }
const MAX_ENTRIES = 32
const MAX_CHARACTERS = 2_097_152
const caches = new WeakMap<Document, Map<string, DiagramResource>>()

export interface DiagramResource {
  characters: number
  isActive: () => boolean
  getSnapshot: () => DiagramSnapshot
  subscribe: (listener: () => void) => () => void
  prepare: () => void
}

function trimCache(cache: Map<string, DiagramResource>) {
  let characters = [...cache.values()].reduce((sum, entry) => sum + entry.characters, 0)
  for (const [key, resource] of cache) {
    if (cache.size <= MAX_ENTRIES && characters <= MAX_CHARACTERS) break
    if (resource.isActive()) continue
    characters -= resource.characters
    cache.delete(key)
  }
}

/** Compiled results outlive virtual rows; no live SVG nodes or viewer instances are retained. */
export function getDiagramResource(document: Document, request: DiagramRequest): DiagramResource {
  let cache = caches.get(document)
  if (!cache) {
    cache = new Map()
    caches.set(document, cache)
  }
  const key = JSON.stringify([
    request.kind,
    request.theme,
    request.kind === 'plantuml' ? (request.plantumlServerUrl ?? '') : '',
    request.code,
  ])
  const existing = cache.get(key)
  if (existing) {
    cache.delete(key)
    cache.set(key, existing)
    return existing
  }
  const ownerCache = cache
  const listeners = new Set<() => void>()
  let snapshot = LOADING
  let pending = false
  const emit = () => listeners.forEach(listener => listener())
  const resource: DiagramResource = {
    characters: key.length,
    isActive: () => pending || listeners.size > 0,
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        trimCache(ownerCache)
      }
    },
    prepare: () => {
      if (pending || snapshot.status === 'ready') return
      pending = true
      if (!ownerCache.has(key)) ownerCache.set(key, resource)
      snapshot = LOADING
      emit()
      void import('./renderDiagramArtifact')
        .then(({ renderDiagramArtifact }) =>
          renderDiagramArtifact(document, request, () => listeners.size > 0)
        )
        .then(
          artifact => {
            pending = false
            if (!artifact) {
              if (listeners.size) resource.prepare()
              return
            }
            snapshot = { status: 'ready', artifact }
            resource.characters = key.length + artifact.svg.length + artifact.src.length
            trimCache(ownerCache)
            emit()
          },
          () => {
            pending = false
            snapshot = { status: 'error' }
            // Failed requests are retried explicitly and never poison later mounts.
            if (ownerCache.get(key) === resource) ownerCache.delete(key)
            emit()
          }
        )
    },
  }
  cache.set(key, resource)
  trimCache(cache)
  return resource
}

export const getIdleDiagramSnapshot = () => LOADING
