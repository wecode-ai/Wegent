import { describe, expect, it } from 'vitest'
import { showAllCollaborationIssues } from '../../e2e/desktop/modules/collaboration-board-flows.mjs'

describe('full-board story readiness', () => {
  it.each(['empty', 'assigned', 'arrives-before-click', 'disappears-before-click'])(
    'pins the explicit all-issues choice when personal work is %s',
    async phase => {
      let personalChoice: boolean | null = null
      let hasPersonalWork = phase === 'assigned' || phase === 'disappears-before-click'
      const pressed = () => personalChoice ?? hasPersonalWork
      const control = {
        async command(action: string, selector: string) {
          if (action === 'getAttribute') {
            const value = String(pressed())
            if (phase === 'arrives-before-click') hasPersonalWork = true
            if (phase === 'disappears-before-click') hasPersonalWork = false
            return value
          }
          if (action === 'clickWhenEnabled') personalChoice = !pressed()
          if (action === 'waitFor' && selector.includes('aria-pressed="false"'))
            expect(pressed()).toBe(false)
        },
      }
      await showAllCollaborationIssues(control, '[data-board]')
      hasPersonalWork = true
      expect(personalChoice).toBe(false)
      expect(pressed()).toBe(false)
    }
  )
})
