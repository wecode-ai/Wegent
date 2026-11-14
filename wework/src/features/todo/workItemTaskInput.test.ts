// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { updateIssueWhenPersonalTaskStarts, workItemAssociationUpdate } from './workItemTaskInput'

describe('personal task project association', () => {
  it('preserves an Issue status when attaching project tags', () => {
    const issue = { status: 'in_review', version: 4, tags: ['existing'] }
    expect(workItemAssociationUpdate(issue, ['existing', 'project:7'])).toEqual({
      version: 4,
      tags: ['existing', 'project:7'],
    })
  })

  it('does not write an Issue when its project association is unchanged', () => {
    expect(workItemAssociationUpdate({ version: 4, tags: ['project:7'] }, ['project:7'])).toBeNull()
  })
})

describe('personal task Issue status ownership', () => {
  it.each([
    { projectStore: 'local' as const },
    { projectStore: 'backend' as const, dispatchRoundId: 'human-round' },
  ])('leaves lifecycle and manager-owned status untouched: %j', async context => {
    const issues = { get: vi.fn(), update: vi.fn() }
    await expect(updateIssueWhenPersonalTaskStarts(issues, 'issue', context)).resolves.toBeNull()
    expect(issues.get).not.toHaveBeenCalled()
    expect(issues.update).not.toHaveBeenCalled()
  })

  it.each(['inbox', 'pending', 'in_review'])(
    'starts an ordinary cloud Issue from %s',
    async status => {
      const source = { id: 'issue', status, tags: [], version: 3 }
      const issues = {
        get: vi.fn().mockResolvedValue(source),
        update: vi.fn().mockResolvedValue({ ...source, status: 'in_progress', version: 4 }),
      }
      await expect(
        updateIssueWhenPersonalTaskStarts(issues, source.id, { projectStore: 'backend' })
      ).resolves.toBeNull()
      expect(issues.update).toHaveBeenCalledExactlyOnceWith(source.id, {
        version: 3,
        status: 'in_progress',
      })
    }
  )

  it('starts a direct human assignment without treating it as a manager round', async () => {
    const issues = {
      get: vi.fn().mockResolvedValue({ id: 'issue', status: 'pending', tags: [], version: 3 }),
      update: vi.fn().mockResolvedValue({}),
    }
    await expect(
      updateIssueWhenPersonalTaskStarts(issues, 'issue', {
        projectStore: 'backend',
        dispatchRoundId: 'direct',
      })
    ).resolves.toBeNull()
    expect(issues.update).toHaveBeenCalledExactlyOnceWith('issue', {
      version: 3,
      status: 'in_progress',
    })
  })

  it('reports a cloud permission denial without rejecting the accepted task', async () => {
    const issues = {
      get: vi.fn().mockResolvedValue({ id: 'issue', status: 'pending', tags: [], version: 3 }),
      update: vi.fn().mockRejectedValue(new Error('Forbidden')),
    }
    await expect(
      updateIssueWhenPersonalTaskStarts(issues, 'issue', { projectStore: 'backend' })
    ).resolves.toBe('Forbidden')
    expect(issues.get).toHaveBeenCalledOnce()
    expect(issues.update).toHaveBeenCalledOnce()
  })
})
