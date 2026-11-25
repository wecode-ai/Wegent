import { afterEach, expect, test, vi } from 'vitest'
import { recordComposerSubmitModel } from './composer-submit-model-diagnostics'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { runDesktopControlClient } from './automation'

vi.mock('@/lib/runtime-create-diagnostics', () => ({ logRuntimeTaskCreateStage: vi.fn() }))

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function mountComposer() {
  document.body.innerHTML = `
    <main data-testid="desktop-workbench-main" data-active-workbench-pane="false">
      <button data-testid="model-selector-button">Other pane model</button>
    </main>
    <main data-testid="desktop-workbench-main" data-active-workbench-pane="true">
      <button data-testid="model-selector-button" data-model-provider-id="fixture">Anthropic</button>
      <div data-testid="chat-message-input" contenteditable="true">private draft</div>
      <div data-token="private-token">private transcript</div>
    </main>`
  return document.querySelector<HTMLElement>('[data-testid="chat-message-input"]')!
}

test('records the current submitting pane model rather than another pane or an earlier selection', () => {
  const input = mountComposer()
  const button = input.parentElement!.querySelector('button')!
  button.textContent = 'Luna'
  recordComposerSubmitModel(input, { key: 'Enter' })
  expect(logRuntimeTaskCreateStage).toHaveBeenCalledExactlyOnceWith('e2e-composer-submit-model', {
    activePane: true,
    modelControlCount: 1,
    models: [{ label: 'Luna', providerId: 'fixture' }],
  })
  expect(JSON.stringify(vi.mocked(logRuntimeTaskCreateStage).mock.calls)).not.toContain('private')
})

test.each([
  { key: 'Enter', shiftKey: true },
  { key: 'Enter', ctrlKey: true },
  { key: 'Enter', metaKey: true },
  { key: 'Enter', altKey: true },
  { key: 'Escape' },
])('does not record non-submit keys %j', event => {
  recordComposerSubmitModel(mountComposer(), event)
  expect(logRuntimeTaskCreateStage).not.toHaveBeenCalled()
})

test('does not read unrelated keyboard targets', () => {
  const input = mountComposer()
  recordComposerSubmitModel(input.parentElement!.querySelector('button')!, { key: 'Enter' })
  expect(logRuntimeTaskCreateStage).not.toHaveBeenCalled()
})

test('the control driver records the model before the submit handler changes the pane', async () => {
  const input = mountComposer()
  const button = input.parentElement!.querySelector('button')!
  let observedAtSubmit: unknown
  input.addEventListener('keydown', () => {
    observedAtSubmit = vi
      .mocked(logRuntimeTaskCreateStage)
      .mock.calls.find(([stage]) => stage === 'e2e-composer-submit-model')?.[1]
    button.textContent = 'Model after submission'
  })
  let delivered = false
  const results: Array<{ ok: boolean }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      if (delivered) return new Response(null, { status: 410 })
      delivered = true
      return Response.json({
        id: 'submit-model',
        action: 'press',
        selector: '[data-testid="chat-message-input"]',
        key: 'Enter',
      })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(init?.body)))
    return Response.json({})
  })

  await runDesktopControlClient('http://127.0.0.1:43111', 'main')

  expect(results).toEqual([expect.objectContaining({ ok: true })])
  expect(observedAtSubmit).toMatchObject({
    models: [{ label: 'Anthropic', providerId: 'fixture' }],
  })
  expect(button.textContent).toBe('Model after submission')
})
