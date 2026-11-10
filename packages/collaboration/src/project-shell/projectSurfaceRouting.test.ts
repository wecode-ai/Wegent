import { afterEach, describe, expect, it, vi } from 'vitest'

import * as surfaces from './projectSurfaces'
import {
  defaultProjectSurfaceFeatureFlags,
  projectSurfacesFeatureFlag,
  resolveEnabledProjectSurface,
} from './projectSurfaceRouting'

afterEach(() => vi.restoreAllMocks())

describe('collab.projectSurfaces.v1 isolation', () => {
  it.each(Object.keys(surfaces.projectViewRegistry))(
    'does not read query or invoke either resolver when disabled: %s',
    view => {
      const parse = vi.spyOn(surfaces, 'parseProjectSurfaceQuery')
      const resolve = vi.spyOn(surfaces, 'resolveProjectSurface')
      const query = { get: vi.fn(() => view) }

      expect(defaultProjectSurfaceFeatureFlags[projectSurfacesFeatureFlag]).toBe(false)
      expect(resolveEnabledProjectSurface(query)).toBeNull()
      expect(resolveEnabledProjectSurface(query, {})).toBeNull()
      expect(
        resolveEnabledProjectSurface(query, { [projectSurfacesFeatureFlag]: false })
      ).toBeNull()
      expect(query.get).not.toHaveBeenCalled()
      expect(parse).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
    }
  )

  it('enables pure parsing and immediately stops on rollback without mutation', () => {
    const query = new URLSearchParams('surface=plan&mode=timeline')
    const before = query.toString()
    const parse = vi.spyOn(surfaces, 'parseProjectSurfaceQuery')

    expect(resolveEnabledProjectSurface(query, { [projectSurfacesFeatureFlag]: true })).toEqual({
      surface: 'plan',
      mode: 'timeline',
      legacyView: 'calendar',
      timelineSubview: 'calendar',
      lossy: true,
      unsupported: false,
    })
    expect(parse).toHaveBeenCalledOnce()
    expect(resolveEnabledProjectSurface(query, { [projectSurfacesFeatureFlag]: false })).toBeNull()
    expect(parse).toHaveBeenCalledOnce()
    expect(query.toString()).toBe(before)
  })
})
