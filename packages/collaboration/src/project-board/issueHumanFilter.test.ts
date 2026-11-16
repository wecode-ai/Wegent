import { describe, expect, it } from 'vitest'
import type { IssueHumanRequest } from '../issueParticipation'
import { matchesBoardView } from './projectBoardViews'

describe('needs my input board view', () => {
  const item = {
    tags: ['backend'],
    status: 'in_progress',
    human_requests: [{ status: 'pending', recipient_user_id: 7 } as IssueHumanRequest],
  }
  const view = { filter: { needs_my_input: true, tags: ['backend'] } }
  it('resolves me for the current viewer instead of the person who saved the view', () => {
    expect(matchesBoardView(item, view, 7)).toBe(true)
    expect(matchesBoardView(item, view, 8)).toBe(false)
    expect(matchesBoardView(item, view)).toBe(false)
  })
  it('combines tag and participation filters and ignores terminal Issues', () => {
    expect(matchesBoardView({ ...item, tags: ['frontend'] }, view, 7)).toBe(false)
    expect(matchesBoardView({ ...item, status: 'completed' }, view, 7)).toBe(false)
    expect(matchesBoardView(item, { filter: { tags: ['backend'] } }, 8)).toBe(true)
  })
})
