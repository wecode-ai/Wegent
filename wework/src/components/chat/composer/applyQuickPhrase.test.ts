import { expect, test, vi } from 'vitest'
import { applyQuickPhrase } from '@wegent/collaboration/composer/applyQuickPhrase'

test('selecting a plan does not publish an intermediate default-mode preference', () => {
  const persistMode = vi.fn()
  const composer = { getValue: () => 'Existing draft', setValue: vi.fn(), focus: vi.fn() }

  applyQuickPhrase(
    { id: 'plan', title: 'Plan', content: 'Inspect the project', mode: 'plan' },
    composer,
    {
      clearPlan: () => persistMode('default'),
      setPlan: () => persistMode('plan'),
    }
  )

  expect(persistMode.mock.calls).toEqual([['plan']])
  expect(composer.setValue).toHaveBeenCalledWith(
    'Existing draft\nInspect the project',
    'Existing draft\nInspect the project'.length
  )
})
