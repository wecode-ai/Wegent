// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationView } from '../types'

export type ProjectSurface = 'work' | 'plan' | 'admin'
export type ProjectSurfaceMode =
  | 'board'
  | 'timeline'
  | 'milestones'
  | 'table'
  | 'files'
  | 'settings'
export type TimelineSubview = 'calendar' | 'gantt'

// Extensions register here before adding their exhaustive mapping below.
export const projectViewRegistry = Object.freeze({
  board: 'standard',
  calendar: 'extension',
  gantt: 'extension',
  table: 'standard',
  milestones: 'extension',
  files: 'standard',
  manage: 'standard',
} as const satisfies Record<CollaborationView, 'standard' | 'extension'> &
  Record<string, 'standard' | 'extension'>)

export type KnownProjectView = keyof typeof projectViewRegistry

type TimelineIdentity = {
  [View in TimelineSubview]: {
    surface: 'plan'
    mode: 'timeline'
    legacyView: View
    timelineSubview: View
  }
}[TimelineSubview]

type ProjectSurfaceIdentity =
  | {
      surface: 'work'
      mode: 'board'
      legacyView: 'board'
      timelineSubview: null
    }
  | TimelineIdentity
  | {
      [View in 'milestones' | 'table']: {
        surface: 'plan'
        mode: View
        legacyView: View
        timelineSubview: null
      }
    }['milestones' | 'table']
  | {
      surface: 'admin'
      mode: 'files'
      legacyView: 'files'
      timelineSubview: null
    }
  | {
      surface: 'admin'
      mode: 'settings'
      legacyView: 'manage'
      timelineSubview: null
    }

export type ResolvedProjectSurface = ProjectSurfaceIdentity & {
  lossy: boolean
  unsupported: boolean
}

export interface ProjectSurfaceQuery {
  get(name: string): string | null
}

export function isKnownProjectView(view: string): view is KnownProjectView {
  return Object.hasOwn(projectViewRegistry, view)
}

function assertNever(view: never): never {
  throw new Error(`Missing project surface mapping: ${view}`)
}

function resolveKnownProjectView(view: KnownProjectView): ProjectSurfaceIdentity {
  switch (view) {
    case 'board':
      return { surface: 'work', mode: 'board', legacyView: view, timelineSubview: null }
    case 'calendar':
      return { surface: 'plan', mode: 'timeline', legacyView: view, timelineSubview: view }
    case 'gantt':
      return { surface: 'plan', mode: 'timeline', legacyView: view, timelineSubview: view }
    case 'table':
      return { surface: 'plan', mode: 'table', legacyView: view, timelineSubview: null }
    case 'milestones':
      return { surface: 'plan', mode: 'milestones', legacyView: view, timelineSubview: null }
    case 'files':
      return { surface: 'admin', mode: 'files', legacyView: view, timelineSubview: null }
    case 'manage':
      return { surface: 'admin', mode: 'settings', legacyView: view, timelineSubview: null }
    default:
      return assertNever(view)
  }
}

function unsupportedSurface(): ResolvedProjectSurface {
  return { ...resolveKnownProjectView('board'), lossy: true, unsupported: true }
}

export function resolveProjectSurface(view: string): ResolvedProjectSurface {
  return isKnownProjectView(view)
    ? { ...resolveKnownProjectView(view), lossy: false, unsupported: false }
    : unsupportedSurface()
}

// Only these surface/mode pairs are valid. Defaults do not change the old navigation.
const surfaceModes = {
  work: { board: 'board' },
  plan: { timeline: 'calendar', milestones: 'milestones', table: 'table' },
  admin: { files: 'files', settings: 'manage' },
} as const satisfies Record<ProjectSurface, Partial<Record<ProjectSurfaceMode, CollaborationView>>>

const defaultModes = {
  work: 'board',
  plan: 'timeline',
  admin: 'files',
} as const satisfies Record<ProjectSurface, ProjectSurfaceMode>

/** Uses the first value of repeated query keys, matching URLSearchParams.get. */
export function parseProjectSurfaceQuery(
  query: string | ProjectSurfaceQuery
): ResolvedProjectSurface {
  const params = typeof query === 'string' ? new URLSearchParams(query) : query
  const view = params.get('view')
  if (view !== null && isKnownProjectView(view)) return resolveProjectSurface(view)

  const surface = params.get('surface')
  const requestedMode = params.get('mode')
  if (surface === null && requestedMode === null) {
    return view === null ? resolveProjectSurface('board') : unsupportedSurface()
  }
  if (surface === null || !Object.hasOwn(surfaceModes, surface)) return unsupportedSurface()

  const knownSurface = surface as ProjectSurface
  const mode = requestedMode ?? defaultModes[knownSurface]
  const modes: Partial<Record<string, CollaborationView>> = surfaceModes[knownSurface]
  if (!Object.hasOwn(modes, mode)) return unsupportedSurface()

  const legacyView = modes[mode]
  if (legacyView === undefined) return unsupportedSurface()
  return { ...resolveProjectSurface(legacyView), lossy: mode === 'timeline' }
}
