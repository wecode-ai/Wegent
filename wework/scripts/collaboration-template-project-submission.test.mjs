// @vitest-environment jsdom

import { afterEach, expect, test, vi } from 'vitest'
import { submitConfiguredTemplateProject } from '../e2e/desktop/scenarios/collaboration-templates.scenario.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = id => `${CONTENT} [data-testid="${id}"]`
const DIALOG =
  '[data-testid="workspace-tab-content-fixed-board"] [data-testid="collaboration-project-create-dialog"]'
const NAME = 'Template project'
const UI_TIMEOUT = 10_000
const WORKBENCH_TIMEOUT = 180_000
const hosts = []

afterEach(() => {
  vi.useRealTimers()
  for (const host of hosts.splice(0)) host.remove()
})

function fixture({ applyError, headerError } = {}) {
  const host = document.createElement('div')
  host.dataset.workspaceTabContent = ''
  host.dataset.testid = 'workspace-tab-content-fixed-board'
  host.setAttribute('aria-hidden', 'false')
  host.innerHTML = `
    <section data-testid="collaboration-project-create-dialog">
      <form hidden style="display: none">
        <input data-testid="collaboration-project-name-input" />
        <button type="submit" disabled data-testid="collaboration-project-create-confirm">Create</button>
      </form>
      <div data-testid="project-create-template-configuration">
        <button data-testid="project-create-template-configuration-apply">Confirm configuration</button>
      </div>
    </section>`
  document.body.append(host)
  hosts.push(host)
  const dialog = host.querySelector('section')
  const form = host.querySelector('form')
  const configuration = host.querySelector('[data-testid="project-create-template-configuration"]')
  const apply = host.querySelector('[data-testid="project-create-template-configuration-apply"]')
  const confirm = host.querySelector('[data-testid="collaboration-project-create-confirm"]')
  const input = host.querySelector('input')
  let submitted = false
  form.addEventListener('submit', event => {
    event.preventDefault()
    submitted = true
    confirm.disabled = true
  })
  apply.addEventListener('click', () => {
    configuration.hidden = true
    form.hidden = false
    form.style.display = 'contents'
  })
  const visible = element => {
    for (let current = element; current; current = current.parentElement) {
      if (
        current.hidden ||
        current.style.display === 'none' ||
        current.getAttribute('aria-hidden') === 'true'
      )
        return false
    }
    return true
  }
  const command = vi.fn(async (action, selector, options = {}) => {
    const elements = [...document.querySelectorAll(selector)]
    if (action === 'getElementCount') {
      expect(selector).toBe(DIALOG)
      return String(elements.length)
    }
    if (selector === scoped('project-create-template-configuration-apply') && applyError)
      throw applyError
    if (selector === scoped('cloud-project-header-title')) {
      expect(action).toBe('waitFor')
      expect(dialog.isConnected).toBe(false)
      expect(options).toEqual({ text: NAME, timeoutMs: UI_TIMEOUT })
      if (headerError) throw headerError
    }
    if (action === 'waitFor' && options.visible === false) {
      expect(elements.filter(visible)).toHaveLength(0)
      return ''
    }
    const element = elements[0]
    expect(element, `Missing ${selector}`).toBeTruthy()
    if (options.visible) expect(visible(element), `Hidden ${selector}`).toBe(true)
    if (options.enabled || action === 'clickWhenEnabled') expect(element.disabled).not.toBe(true)
    if (options.text) expect(element.textContent).toContain(options.text)
    if (action === 'clickWhenEnabled') element.click()
    else if (action === 'fill') {
      element.value = options.value
      confirm.disabled = !element.value.trim()
    } else expect(action).toBe('waitFor')
    return element.textContent ?? ''
  })
  return {
    command,
    host,
    dialog,
    apply,
    input,
    get submitted() {
      return submitted
    },
    complete() {
      expect(submitted).toBe(true)
      dialog.remove()
      host.setAttribute('aria-hidden', 'false')
      const header = document.createElement('h1')
      header.dataset.testid = 'cloud-project-header-title'
      header.textContent = NAME
      host.append(header)
    },
  }
}

const submit = (control, beforeSubmit = vi.fn()) =>
  submitConfiguredTemplateProject(control, {
    projectName: NAME,
    uiTimeoutMs: UI_TIMEOUT,
    workbenchReadyTimeoutMs: WORKBENCH_TIMEOUT,
    beforeSubmit,
  })

test('the former hidden-footer wait passes while the real form is still mounted', async () => {
  const control = fixture()
  await control.command('fill', scoped('collaboration-project-name-input'), { value: NAME })
  await control.command('clickWhenEnabled', scoped('collaboration-project-create-confirm'))
  await control.command('waitFor', scoped('collaboration-project-create-confirm'), {
    visible: false,
    timeoutMs: WORKBENCH_TIMEOUT,
  })
  expect(control.submitted).toBe(true)
  expect(control.dialog.isConnected).toBe(true)
  expect(document.querySelector(scoped('cloud-project-header-title'))).toBeNull()
})

test('confirms the visible configuration and waits for unmount before the original header assertion', async () => {
  vi.useFakeTimers()
  const control = fixture()
  const beforeSubmit = vi.fn()
  const pending = submit(control, beforeSubmit)
  await vi.advanceTimersByTimeAsync(11_000)
  expect(control.submitted).toBe(true)
  expect(control.input.value).toBe(NAME)
  expect(beforeSubmit).toHaveBeenCalledOnce()
  expect(control.dialog.isConnected).toBe(true)
  const headerCalls = () =>
    control.command.mock.calls.filter(([, selector]) =>
      selector.includes('cloud-project-header-title')
    )
  expect(headerCalls()).toHaveLength(0)
  // Hiding the workspace must not make a still-mounted dialog count as complete.
  control.host.setAttribute('aria-hidden', 'true')
  await vi.advanceTimersByTimeAsync(200)
  expect(headerCalls()).toHaveLength(0)
  control.complete()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  expect(headerCalls()).toHaveLength(1)
  expect(control.command.mock.calls.slice(0, 2)).toEqual([
    [
      'clickWhenEnabled',
      scoped('project-create-template-configuration-apply'),
      { visible: true, timeoutMs: UI_TIMEOUT },
    ],
    [
      'waitFor',
      scoped('collaboration-project-create-confirm'),
      { visible: true, timeoutMs: UI_TIMEOUT },
    ],
  ])
  expect(
    control.command.mock.calls.find(
      ([action, selector]) =>
        action === 'clickWhenEnabled' && selector === scoped('collaboration-project-create-confirm')
    )?.[2]
  ).toEqual({ visible: true, timeoutMs: UI_TIMEOUT })
})

test('preserves a header failure after resource configuration has completed', async () => {
  vi.useFakeTimers()
  const original = new Error('The original header assertion failed')
  const control = fixture({ headerError: original })
  const pending = expect(submit(control)).rejects.toBe(original)
  await vi.advanceTimersByTimeAsync(100)
  control.complete()
  await vi.advanceTimersByTimeAsync(100)
  await pending
})

test('rejects a missing configuration confirmation instead of submitting the hidden form', async () => {
  const control = fixture()
  control.apply.remove()
  await expect(submit(control)).rejects.toThrow('Missing')
  expect(control.submitted).toBe(false)
  expect(control.command).toHaveBeenCalledOnce()
})

test('preserves an error from configuration confirmation', async () => {
  const original = new Error('Configuration confirmation failed')
  const control = fixture({ applyError: original })
  await expect(submit(control)).rejects.toBe(original)
  expect(control.submitted).toBe(false)
  expect(control.command).toHaveBeenCalledOnce()
})

test('keeps the existing completion budget and rejects a dialog that never unmounts', async () => {
  vi.useFakeTimers()
  const control = fixture()
  const pending = expect(submit(control)).rejects.toThrow(
    'Template project configuration did not finish'
  )
  await vi.advanceTimersByTimeAsync(WORKBENCH_TIMEOUT)
  await pending
  expect(control.dialog.isConnected).toBe(true)
  expect(
    control.command.mock.calls.some(([, selector]) =>
      selector.includes('cloud-project-header-title')
    )
  ).toBe(false)
})
