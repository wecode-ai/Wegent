import { afterEach, describe, expect, it } from 'vitest'
import { verifyPendingInteractionsTab } from '../../e2e/desktop/modules/pending-interactions-tab.mjs'

const tabId = 'workspace-tab-select-pending-interactions'
const counterId = 'workspace-tab-pending-count-pending-interactions'

function fixture(questions: number, state: string, projects: number | null) {
  const tab = document.createElement('button')
  tab.dataset.testid = tabId
  tab.dataset.pendingQuestionCount = String(questions)
  tab.dataset.projectCountState = state
  const total = projects == null ? null : questions + projects
  tab.title = total == null ? '待你处理' : `待你处理（${total}）`
  tab.textContent = '待你处理'
  if (projects != null) tab.dataset.projectPendingCount = String(projects)
  if (total != null) {
    const counter = document.createElement('span')
    counter.dataset.testid = counterId
    counter.textContent = `（${total}）`
    tab.append(counter)
  }
  document.body.append(tab)
}

const control = {
  async command(
    action: string,
    selector: string,
    options: { text?: string; visible?: boolean; value?: string } = {}
  ) {
    const element = document.querySelector<HTMLElement>(selector)
    if (action === 'getElementCount') return String(document.querySelectorAll(selector).length)
    if (action === 'waitFor') {
      if (options.visible === false) expect(element).toBeNull()
      else {
        expect(element, selector).not.toBeNull()
        if (options.text) expect(element?.textContent).toContain(options.text)
      }
      return ''
    }
    if (!element) throw new Error(`Missing fixture: ${selector}`)
    if (action === 'getAttribute') return element.getAttribute(options.value ?? '') ?? ''
    if (action === 'getText') return element.textContent ?? ''
    if (action === 'getElementMetrics') {
      const requested = options.value?.startsWith('{') ? JSON.parse(options.value) : {}
      return JSON.stringify(
        [...document.querySelectorAll<HTMLElement>(selector)].map(element => {
          const counter = element.dataset.testid === counterId
          return {
            testId: element.dataset.testid,
            text: element.textContent?.trim(),
            attributes: Object.fromEntries(
              (requested.attributeNames ?? []).map((name: string) => [
                name,
                element.getAttribute(name),
              ])
            ),
            visible: true,
            left: counter ? 80 : 0,
            right: 120,
            width: counter ? 40 : 120,
            scrollWidth: 40,
            clientWidth: 40,
          }
        })
      )
    }
    throw new Error(`Unexpected control action: ${action}`)
  },
}

afterEach(() => document.body.replaceChildren())

describe('pending tab E2E verifier contract', () => {
  it('uses the current coherent snapshot when bootstrap discovery completes between commands', async () => {
    fixture(1, 'unknown', null)
    const changingControl = {
      async command(action: string, selector: string, options = {}) {
        if (action === 'getElementMetrics') {
          document.body.replaceChildren()
          fixture(1, 'known', 0)
        }
        if (
          action === 'getAttribute' &&
          'value' in options &&
          options.value === 'data-project-count-state'
        )
          throw new Error('Do not read count state in another renderer tick')
        return control.command(action, selector, options)
      },
    }
    await verifyPendingInteractionsTab(changingControl, 1)
  })
  it.each([
    { questions: 1, state: 'unknown', initialProjects: null, expectedProjects: 0 },
    { questions: 0, state: 'known', initialProjects: 0, expectedProjects: 1 },
  ])(
    'waits for exact Q/P readiness through $state P=$initialProjects to P=$expectedProjects',
    async ({ questions, state, initialProjects, expectedProjects }) => {
      fixture(questions, state, initialProjects)
      const gate = `[data-pending-question-count="${questions}"][data-project-count-state="known"][data-project-pending-count="${expectedProjects}"]`
      const calls: string[] = []
      const settlingControl = {
        async command(action: string, selector: string, options = {}) {
          calls.push(selector)
          if (action === 'getElementMetrics' && selector.includes(gate)) {
            document.body.replaceChildren()
            fixture(questions, 'known', expectedProjects)
          }
          if (
            action === 'getAttribute' &&
            'value' in options &&
            options.value === 'data-project-count-state'
          )
            throw new Error(
              'A successful fixture must not derive its badge from a later transient state'
            )
          return control.command(action, selector, options)
        },
      }

      await verifyPendingInteractionsTab(settlingControl, questions, {
        expectedProjectCount: expectedProjects,
      })

      expect(calls[0]).toContain(gate)
      expect(document.querySelector(`[data-testid="${counterId}"]`)?.textContent).toBe(
        `（${questions + expectedProjects}）`
      )
    }
  )

  it('rejects a stale known project count instead of accepting its old aggregate', async () => {
    fixture(0, 'known', 0)
    await expect(
      verifyPendingInteractionsTab(control, 0, { expectedProjectCount: 1 })
    ).rejects.toThrow()
  })

  it('waits for the provider before deriving a bootstrap count and title', async () => {
    fixture(0, 'loading', null)
    const settlingControl = {
      async command(action: string, selector: string, options = {}) {
        if (
          action === 'getElementMetrics' &&
          selector.includes(':not([data-project-count-state="loading"])')
        ) {
          document.body.replaceChildren()
          fixture(0, 'unsupported', 0)
        }
        return control.command(action, selector, options)
      },
    }
    await verifyPendingInteractionsTab(settlingControl, 0)
  })
  it('checks exact questions plus projects using the rendered localized badge', async () => {
    fixture(2, 'known', 3)
    await verifyPendingInteractionsTab(control, 2)
  })

  it('requires no badge for unknown project counts without inventing zero', async () => {
    fixture(1, 'unknown', null)
    await verifyPendingInteractionsTab(control, 1)
  })

  it('keeps the exact question count when project items are unsupported', async () => {
    fixture(1, 'unsupported', 0)
    await verifyPendingInteractionsTab(control, 1)
  })

  it('does not accept bare digits instead of the real formatted badge', async () => {
    fixture(1, 'known', 0)
    document.querySelector(`[data-testid="${counterId}"]`)!.textContent = '1'
    await expect(verifyPendingInteractionsTab(control, 1)).rejects.toThrow()
  })

  it('waits for successful project discovery rather than treating loading as an error', async () => {
    fixture(1, 'unknown', null)
    const calls: string[] = []
    const settlingControl = {
      async command(action: string, selector: string, options = {}) {
        calls.push(selector)
        if (
          action === 'getElementMetrics' &&
          selector.includes('[data-project-count-state="known"]')
        ) {
          expect(
            document
              .querySelector(`[data-testid="${tabId}"]`)
              ?.getAttribute('data-project-count-state')
          ).toBe('unknown')
          document.body.replaceChildren()
          fixture(1, 'known', 0)
        }
        return control.command(action, selector, options)
      },
    }

    await verifyPendingInteractionsTab(settlingControl, 1, { requireProjectCountKnown: true })

    expect(calls[0]).toContain('[data-project-count-state="known"]')
    expect(calls.some(selector => selector.includes('project-work-error'))).toBe(false)
  })

  it('does not accept an unresolved project count for a successful discovery fixture', async () => {
    fixture(1, 'unknown', null)

    await expect(
      verifyPendingInteractionsTab(control, 1, { requireProjectCountKnown: true })
    ).rejects.toThrow()
  })
})
