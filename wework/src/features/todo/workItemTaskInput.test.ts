// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { workItemAssociationUpdate } from './workItemTaskInput'

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
