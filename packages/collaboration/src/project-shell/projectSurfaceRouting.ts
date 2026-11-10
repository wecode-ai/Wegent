// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  parseProjectSurfaceQuery,
  type ProjectSurfaceQuery,
  type ResolvedProjectSurface,
} from './projectSurfaces'

export const projectSurfacesFeatureFlag = 'collab.projectSurfaces.v1' as const

export type ProjectSurfaceFeatureFlags = Partial<Record<typeof projectSurfacesFeatureFlag, boolean>>

export const defaultProjectSurfaceFeatureFlags = Object.freeze({
  [projectSurfacesFeatureFlag]: false,
})

/** Keep the gate outside the parser so a disabled flag never invokes a resolver. */
export function resolveEnabledProjectSurface(
  query: string | ProjectSurfaceQuery,
  flags: ProjectSurfaceFeatureFlags = defaultProjectSurfaceFeatureFlags
): ResolvedProjectSurface | null {
  return flags[projectSurfacesFeatureFlag] === true ? parseProjectSurfaceQuery(query) : null
}
