import { describe, expect, expectTypeOf, it } from 'vitest'

import type { CollaborationView } from '../types'
import matrix from './__fixtures__/resolver-matrix.json'
import {
  isKnownProjectView,
  parseProjectSurfaceQuery,
  projectViewRegistry,
  resolveProjectSurface,
  type KnownProjectView,
  type ResolvedProjectSurface,
} from './projectSurfaces'

describe('project surface golden contract', () => {
  it('retains all 15 supplied cases and the exact six result fields', () => {
    expect(matrix.cases).toHaveLength(15)
    expect(new Set(matrix.cases.map(entry => entry.id)).size).toBe(15)
    expectTypeOf<KnownProjectView>().toEqualTypeOf<CollaborationView>()
  })

  it.each(matrix.cases)('$id', ({ input, expected }) => {
    const result =
      input.kind === 'legacy'
        ? resolveProjectSurface(input.view!)
        : parseProjectSurfaceQuery(input.query!)
    expect(result).toEqual(expected)
    expect(Object.keys(result).sort()).toEqual([...matrix.resultKeys].sort())
  })

  it('registers each existing view exactly once, including host extensions', () => {
    const fixtureViews = matrix.cases
      .filter(entry => entry.input.kind === 'legacy' && !entry.expected.unsupported)
      .map(entry => entry.input.view)
    expect(Object.keys(projectViewRegistry).sort()).toEqual(fixtureViews.sort())
    expect(projectViewRegistry.calendar).toBe('extension')
    expect(projectViewRegistry.gantt).toBe('extension')
    expect(projectViewRegistry.milestones).toBe('extension')
  })
})

describe('query precedence and boundaries', () => {
  it.each(Object.keys(projectViewRegistry))('prioritizes valid legacy view %s', view => {
    expect(parseProjectSurfaceQuery(`view=${view}&surface=nope&mode=invalid`)).toEqual(
      resolveProjectSurface(view)
    )
  })

  it('keeps gantt when a valid view conflicts with a valid new pair', () => {
    expect(parseProjectSurfaceQuery('surface=admin&mode=files&view=gantt')).toEqual(
      resolveProjectSurface('gantt')
    )
  })

  it.each(['not-a-view', ''])('uses a valid new pair after invalid view %j', view => {
    expect(parseProjectSurfaceQuery(`view=${view}&surface=admin&mode=settings`)).toEqual(
      resolveProjectSurface('manage')
    )
  })

  it.each(['', '?', 'unrelated=value'])('defaults an absent selection for %j', query => {
    expect(parseProjectSurfaceQuery(query)).toEqual(resolveProjectSurface('board'))
  })

  it.each([
    ['surface=work&mode=board', 'board'],
    ['surface=plan&mode=table', 'table'],
    ['surface=admin', 'files'],
    ['surface=admin&mode=files', 'files'],
    ['surface=admin&mode=settings', 'manage'],
  ])('resolves the exact pair %s', (query, view) => {
    expect(parseProjectSurfaceQuery(query)).toEqual(resolveProjectSurface(view))
  })

  it.each([
    'view=not-a-view',
    'view=',
    'mode=board',
    'surface=',
    'surface=work&mode=',
    'surface=plan&mode=board',
    'surface=admin&mode=timeline',
    'surface=constructor&mode=board',
    'surface=work&mode=toString',
    'surface=__proto__&mode=board',
  ])('safely rejects unsupported selection %s', query => {
    expect(parseProjectSurfaceQuery(query)).toEqual(resolveProjectSurface('not-a-view'))
  })

  it.each(['constructor', 'toString', '__proto__', '', 'BOARD', ' board ', '💡', '\u0000'])(
    'accepts arbitrary legacy strings without throwing: %j',
    view => {
      expect(isKnownProjectView(view)).toBe(false)
      expect(resolveProjectSurface(view)).toMatchObject({
        surface: 'work',
        mode: 'board',
        legacyView: 'board',
        timelineSubview: null,
        lossy: true,
        unsupported: true,
      })
    }
  )

  it('uses the first duplicate key consistently', () => {
    expect(parseProjectSurfaceQuery('view=gantt&view=calendar')).toEqual(
      resolveProjectSurface('gantt')
    )
    expect(parseProjectSurfaceQuery('surface=admin&surface=work&mode=files')).toEqual(
      resolveProjectSurface('files')
    )
  })

  it('does not mutate query contents', () => {
    for (const entry of matrix.cases.filter(entry => entry.input.kind === 'query')) {
      const params = new URLSearchParams(entry.input.query)
      const before = params.toString()
      expect(parseProjectSurfaceQuery(params), entry.id).toEqual(entry.expected)
      expect(params.toString(), entry.id).toBe(before)
    }
  })

  it('returns independent results and preserves the discriminated shape', () => {
    const first = resolveProjectSurface('calendar')
    first.lossy = true
    expect(resolveProjectSurface('calendar').lossy).toBe(false)
    for (const view of Object.keys(projectViewRegistry)) {
      const result: ResolvedProjectSurface = resolveProjectSurface(view)
      if (result.mode === 'timeline') {
        expectTypeOf(result.timelineSubview).toEqualTypeOf<'calendar' | 'gantt'>()
        expect(result.timelineSubview).toBe(result.legacyView)
      } else {
        expectTypeOf(result.timelineSubview).toEqualTypeOf<null>()
        expect(result.timelineSubview).toBeNull()
      }
    }
  })
})
