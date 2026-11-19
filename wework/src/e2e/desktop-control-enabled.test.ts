import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { runDesktopControlClient } from './automation'
import { getDesktopControlDiagnostics } from './desktop-control-diagnostics'

interface ControlResult {
  ok: boolean
  value?: string
  error?: string
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function runCommand(command: DesktopControlCommand) {
  const results: ControlResult[] = []
  let polls = 0
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (++polls > 1) return new Response(null, { status: 410 })
      return Response.json(command)
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
    return Response.json({})
  })
  return { results, client: runDesktopControlClient('http://127.0.0.1:43111', 'main') }
}

describe('desktop control enabled state', () => {
  test('waits for inherited fieldset disabling before acknowledging a tag composer click', async () => {
    const fieldset = document.createElement('fieldset')
    fieldset.disabled = true
    const button = document.createElement('button')
    button.dataset.testid = 'cloud-project-tag-create-toggle'
    fieldset.append(button)
    document.body.append(fieldset)
    const clicked = vi.fn(() => {
      const input = document.createElement('input')
      input.dataset.testid = 'cloud-project-tag-create-input'
      fieldset.append(input)
    })
    button.addEventListener('click', clicked)
    expect(button.disabled).toBe(false)
    expect(button.matches(':disabled')).toBe(true)
    button.click()
    expect(clicked).not.toHaveBeenCalled()

    const { client, results } = runCommand({
      id: 'inherited-fieldset-tag-composer',
      action: 'clickWhenEnabled',
      selector: '[data-testid="cloud-project-tag-create-toggle"]',
      timeoutMs: 1000,
    })
    try {
      await vi.waitFor(() =>
        expect(getDesktopControlDiagnostics()).toContainEqual(
          expect.objectContaining({
            commandId: 'inherited-fieldset-tag-composer',
            phase: 'start-acknowledged',
          })
        )
      )
      expect(results).toEqual([])
      expect(clicked).not.toHaveBeenCalled()
      expect(fieldset.querySelector('input')).toBeNull()
      fieldset.disabled = false
      await client
      expect(results).toEqual([expect.objectContaining({ ok: true })])
      expect(clicked).toHaveBeenCalledOnce()
      expect(
        fieldset.querySelector('[data-testid="cloud-project-tag-create-input"]')
      ).not.toBeNull()
    } finally {
      fieldset.disabled = false
      await client
    }
  })

  test('waits for an inert ancestor to release a control', async () => {
    const container = document.createElement('div')
    container.setAttribute('inert', '')
    const button = document.createElement('button')
    button.dataset.testid = 'inert-control'
    container.append(button)
    document.body.append(container)
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    const { client, results } = runCommand({
      id: 'inert-ancestor-control',
      action: 'clickWhenEnabled',
      selector: '[data-testid="inert-control"]',
      timeoutMs: 1000,
    })
    try {
      await vi.waitFor(() =>
        expect(getDesktopControlDiagnostics()).toContainEqual(
          expect.objectContaining({
            commandId: 'inert-ancestor-control',
            phase: 'start-acknowledged',
          })
        )
      )
      expect(results).toEqual([])
      expect(clicked).not.toHaveBeenCalled()
      container.removeAttribute('inert')
      await client
      expect(results).toEqual([expect.objectContaining({ ok: true })])
      expect(clicked).toHaveBeenCalledOnce()
    } finally {
      container.removeAttribute('inert')
      await client
    }
  })

  test.each([
    ['direct disabled', '<button disabled data-testid="target">Create</button>', false],
    [
      'fieldset disabled',
      '<fieldset disabled><button data-testid="target">Create</button></fieldset>',
      false,
    ],
    [
      'first legend exception',
      '<fieldset disabled><legend><button data-testid="target">Create</button></legend></fieldset>',
      true,
    ],
    [
      'second legend disabled',
      '<fieldset disabled><legend>First</legend><legend><button data-testid="target">Create</button></legend></fieldset>',
      false,
    ],
    ['inert self', '<button inert data-testid="target">Create</button>', false],
    [
      'inert ancestor',
      '<section inert><button data-testid="target">Create</button></section>',
      false,
    ],
    ['aria disabled', '<button aria-disabled="true" data-testid="target">Create</button>', false],
    [
      'ordinary disabled attribute',
      '<section disabled><button data-testid="target">Create</button></section>',
      true,
    ],
  ])('preserves native interaction rules for %s', async (_name, markup, enabled) => {
    const container = document.createElement('div')
    container.innerHTML = String(markup)
    document.body.append(container)
    const button = container.querySelector<HTMLButtonElement>('[data-testid="target"]')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    const { client, results } = runCommand({
      id: 'raw-click',
      action: 'click',
      selector: '[data-testid="target"]',
    })
    await client
    expect(results).toEqual([expect.objectContaining({ ok: enabled })])
    expect(clicked).toHaveBeenCalledTimes(enabled ? 1 : 0)
  })
})
