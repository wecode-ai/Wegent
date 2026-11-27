import { ApiError } from '@/api/http'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { describe, expect, it, vi } from 'vitest'
import { resolveIssueReference } from './resolveIssueReference'

function source(location: 'local' | 'cloud') {
  const item = { id: 'WEG-999', cloud_project_id: 'unopened-project' }
  const project = { id: 'unopened-project', project_key: 'WEG' }
  const getIssue = vi.fn().mockResolvedValue(item)
  const getProject = vi.fn().mockResolvedValue(project)
  const api = {
    issues: { get: getIssue },
    projects: { get: getProject },
  } as unknown as SharedWorkspaceApi
  return { location, api, getIssue, getProject }
}

describe('resolveIssueReference', () => {
  it.each(['local', 'cloud'] as const)(
    'reads an unloaded Issue and project from %s',
    async location => {
      const provider = source(location)
      const { matches } = await resolveIssueReference('WEG-999', [provider])
      expect(provider.getIssue).toHaveBeenCalledWith('WEG-999')
      expect(provider.getProject).toHaveBeenCalledWith('unopened-project')
      expect(matches).toMatchObject([
        {
          item: { id: 'WEG-999' },
          project: { location, project_store: location === 'local' ? 'local' : 'backend' },
        },
      ])
    }
  )

  it('retains both source identities when references collide', async () => {
    const { matches } = await resolveIssueReference('WEG-999', [source('local'), source('cloud')])
    expect(matches.map(match => match.project.location)).toEqual(['local', 'cloud'])
  })

  it('does not query the project or fabricate details after denied access', async () => {
    const provider = source('cloud')
    provider.getIssue.mockRejectedValue(new Error('Access denied'))
    expect((await resolveIssueReference('WEG-999', [provider])).failures).toEqual([
      { location: 'cloud', message: 'Access denied' },
    ])
    expect(provider.getProject).not.toHaveBeenCalled()
  })

  it('can return a local Issue when it is absent from the cloud', async () => {
    const cloud = source('cloud')
    cloud.getIssue.mockRejectedValue(new ApiError('Not found', 404))
    const { matches } = await resolveIssueReference('WEG-999', [source('local'), cloud])
    expect(matches).toHaveLength(1)
    expect(matches[0].project.location).toBe('local')
  })
})

it('preserves a failed source alongside successful matches', async () => {
  const cloud = source('cloud')
  cloud.getIssue.mockRejectedValue(new TypeError('Network failed'))
  const result = await resolveIssueReference('WEG-999', [source('local'), cloud])
  expect(result.matches).toHaveLength(1)
  expect(result.failures).toEqual([{ location: 'cloud', message: 'Network failed' }])
})

it('retains a project lookup failure even when the Issue exists', async () => {
  const cloud = source('cloud')
  cloud.getProject.mockRejectedValue(new ApiError('Project not found', 404))
  expect((await resolveIssueReference('WEG-999', [cloud])).failures).toEqual([
    { location: 'cloud', message: 'Project not found' },
  ])
})
