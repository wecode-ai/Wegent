import { describe, expect, it } from 'vitest'
import { standInProjectTags } from '@/api/personalStandIn'
import { updateProjectSource, type ProjectSource } from './standInProjects'

const first = { id: 'shared', store: 'cloud' } as const
const second = { id: 'shared', store: 'local' } as const
const legacySource: ProjectSource = {
  enabled: true,
  allProjects: false,
  projects: [first],
  excludedProjects: [],
  tags: ['legacy'],
}

describe('project receive range tags', () => {
  it('keeps the legacy filter on the original project and leaves new ranges unfiltered', () => {
    const draft = updateProjectSource(legacySource, {
      projects: [first, second],
      includeIndependentIssues: true,
      includeParticipatingIssues: true,
    })

    expect(standInProjectTags(draft, first)).toEqual(['legacy'])
    expect(standInProjectTags(draft, second)).toEqual([])
    expect(draft.tagFilters).toEqual({ independent: [], participating: [] })
  })

  it('keeps a selected project filter when expanding to all projects', () => {
    const expanded = updateProjectSource(legacySource, { allProjects: true, projects: [] })

    expect(standInProjectTags(expanded, first)).toEqual(['legacy'])
    expect(standInProjectTags(expanded, second)).toEqual([])
  })

  it('clears a removed project filter without changing another project filter', () => {
    const saved = {
      ...legacySource,
      projects: [first, second],
      projectTagFilters: [
        { ...first, tags: ['first'] },
        { ...second, tags: ['second'] },
      ],
    }
    const removed = updateProjectSource(saved, { projects: [second] })
    const readded = updateProjectSource(removed, { projects: [first, second] })

    expect(standInProjectTags(readded, first)).toEqual([])
    expect(standInProjectTags(readded, second)).toEqual(['second'])
  })
})
