import { priorityBadgeClasses } from './todoShared'

describe('shared priority badge exports', () => {
  it('resolves every search priority through the collaboration package public export', () => {
    for (const priority of ['none', 'low', 'medium', 'high', 'urgent'] as const) {
      expect(priorityBadgeClasses[priority]).toEqual(expect.stringContaining('bg-'))
      expect(priorityBadgeClasses[priority]).toEqual(expect.stringContaining('text-'))
    }
  })
})
