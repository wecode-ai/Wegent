import { afterEach, expect, it } from 'vitest'
import { verifyInteractionTime } from '../../e2e/desktop/modules/human-interaction-time.mjs'

const page = '[data-testid="runtime-interactions-page"]'
const created = '2026-11-07T22:15:16.902Z'
const accepted = '2026-11-07T22:15:52.235Z'

function fixture(iso: string, hidden = false, selected = true) {
  const root = document.createElement('main')
  root.dataset.testid = 'runtime-interactions-page'
  root.hidden = hidden
  const row = document.createElement('button')
  row.dataset.testid = 'interaction-list-item'
  row.setAttribute('aria-pressed', String(selected))
  const time = (id: string) => {
    const element = document.createElement('time')
    element.dataset.testid = id
    element.dateTime = iso
    element.title = 'Complete local date and time'
    element.textContent = '10:15 PM'
    return element
  }
  row.append(time('interaction-list-time'))
  root.append(row, time('interaction-detail-time'))
  document.body.append(root)
  return root
}

function control(beforeAttribute?: (selector: string) => void) {
  return {
    async command(
      action: string,
      selector: string,
      options: { visible?: boolean; value?: string } = {}
    ) {
      if (action === 'waitFor') {
        expect(
          [...document.querySelectorAll(selector)].some(
            element => !options.visible || !element.closest('[hidden]')
          )
        ).toBe(true)
        return ''
      }
      if (action === 'getAttribute') beforeAttribute?.(selector)
      const element = document.querySelector(selector)
      if (action === 'getAttribute') return element?.getAttribute(options.value ?? '') ?? ''
      if (action === 'getText') return element?.textContent ?? ''
      if (action === 'getElementMetrics') {
        const request = options.value ? JSON.parse(options.value) : {}
        return JSON.stringify(
          [...document.querySelectorAll<HTMLElement>(selector)].map(element => ({
            testId: element.dataset.testid,
            text: element.textContent?.trim(),
            attributes: Object.fromEntries(
              (request.attributeNames ?? []).map((name: string) => [
                name,
                element.getAttribute(name),
              ])
            ),
            rendered: !element.closest('[hidden]'),
            visible: !element.closest('[hidden]'),
            width: 100,
            height: 20,
            left: 10,
            right: 110,
            top: 10,
            bottom: 30,
            viewportWidth: 1000,
            viewportHeight: 800,
            scrollWidth: 100,
            clientWidth: 100,
          }))
        )
      }
      throw new Error(`Unexpected ${action}`)
    },
  }
}

afterEach(() => document.body.replaceChildren())

it.each([false, true])(
  'reads the visible history owner rather than hidden retained detail (selected=%s)',
  async selected => {
    fixture(created, true, selected)
    fixture(accepted)
    expect(await verifyInteractionTime(control(), page, { expected: accepted })).toBe(accepted)
  }
)

it('rejects duplicate visible owners instead of choosing by date', async () => {
  fixture(created)
  fixture(accepted)
  await expect(verifyInteractionTime(control(), page)).rejects.toThrow(
    'Expected one visible time owner'
  )
})

it.each(['list', 'detail'])(
  'rejects duplicate %s time nodes within the active owner',
  async surface => {
    const root = fixture(accepted)
    const time = root.querySelector(`[data-testid="interaction-${surface}-time"]`)!
    time.parentElement!.append(time.cloneNode(true))
    await expect(verifyInteractionTime(control(), page)).rejects.toThrow(
      `Expected one ${surface} time`
    )
  }
)

it('checks the hidden narrow pane only within the same active owner', async () => {
  const root = fixture(accepted)
  root.querySelector('button')!.hidden = true
  expect(
    await verifyInteractionTime(control(), page, { visible: 'detail', expected: accepted })
  ).toBe(accepted)
  await expect(verifyInteractionTime(control(), page)).rejects.toThrow('list time must fit')
})

it('still rejects a real list/detail timestamp mismatch within one owner', async () => {
  const root = fixture(accepted)
  root.querySelector<HTMLTimeElement>('[data-testid="interaction-detail-time"]')!.dateTime = created
  await expect(verifyInteractionTime(control(), page)).rejects.toThrow(
    'List and detail must show the same event time'
  )
})

it('does not split list and detail across separate renderer attribute reads', async () => {
  const root = fixture(created)
  const changing = control(selector => {
    if (selector.includes('interaction-detail-time'))
      root.querySelectorAll('time').forEach(element => {
        element.dateTime = accepted
      })
  })
  expect(await verifyInteractionTime(changing, page)).toBe(created)
})
