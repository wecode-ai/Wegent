// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ProjectCreateDialog } from '../../packages/collaboration/src/project-create/ProjectCreateDialog'
import { projectCreateLabels } from '../../packages/collaboration/src/project-create/labels'
import { builtinCollaborationTemplates } from '../../packages/collaboration/src/templates/builtins'
import { CollaborationTemplateContext } from '../../packages/collaboration/src/templates/context'
import { CollaborationTemplateStore } from '../../packages/collaboration/src/templates/store'
import {
  discardTemplateProjectDraft,
  openTemplateProjectBindings,
  submitConfiguredTemplateProject,
} from '../e2e/desktop/scenarios/collaboration-templates.scenario.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = id => `${CONTENT} [data-testid="${id}"]`
const DIALOG =
  '[data-testid="workspace-tab-content-fixed-board"] [data-testid="collaboration-project-create-dialog"]'
const NAME = 'Template project'
const GROUP_NAME = 'Configured product team'
const UI_TIMEOUT = 10_000
const WORKBENCH_TIMEOUT = 180_000
const roots = []
const get = id => document.querySelector(`[data-testid="${id}"]`)

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // jsdom omits layout APIs used by the real dialog's editor.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  })
})

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function visible(element) {
  if (!element?.isConnected) return false
  for (let current = element; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (
      current.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden'
    )
      return false
    const disclosure = current.parentElement
    if (disclosure?.tagName === 'DETAILS' && !disclosure.open && current.tagName !== 'SUMMARY')
      return false
  }
  return true
}

function deferred() {
  let resolve
  const promise = new Promise(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

async function fixture({ configuration, commandFailure, onCommand = () => {} } = {}) {
  const host = document.createElement('div')
  host.dataset.workspaceTabContent = ''
  host.dataset.testid = 'workspace-tab-content-fixed-board'
  host.setAttribute('aria-hidden', 'false')
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  const builtins = builtinCollaborationTemplates()
  const product = builtins.find(record => record.document.metadata.name === 'product-lifecycle')
  const accountDocument = structuredClone(
    builtins.find(record => record.document.metadata.name === 'research-analysis').document
  )
  accountDocument.metadata = {
    ...accountDocument.metadata,
    namespace: 'default',
    name: 'saved-account-workflow',
  }
  const account = {
    id: null,
    ownerId: 7,
    document: accountDocument,
    source: 'personal',
    revision: null,
  }
  const store = new CollaborationTemplateStore({
    scope: 'cloud:template-submission',
    ownerId: 7,
    persistence: { read: async () => [account], write: async () => {} },
  })
  await store.load()
  const create = vi.fn(async input => ({ id: 'created-project', ...input }))
  const configure = vi.fn(async () => configuration?.promise)
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const firstDialogCheck = deferred()
  const resourceSetup = {
    location: 'cloud',
    currentUser: { id: 7, name: 'Owner' },
    members: [],
    agents: [],
    groups: [],
    configure,
  }

  function Harness() {
    const [selected, select] = useState(null)
    const [created, setCreated] = useState(null)
    return createElement(
      CollaborationTemplateContext,
      { value: store },
      createElement(
        'button',
        { type: 'button', 'data-testid': 'open-account-template', onClick: () => select(account) },
        'Use saved account template'
      ),
      createElement(
        'button',
        { type: 'button', 'data-testid': 'open-product-template', onClick: () => select(product) },
        'Use product template'
      ),
      selected &&
        createElement(ProjectCreateDialog, {
          key: selected.document.metadata.name,
          initialTemplate: selected.document,
          targets: [{ location: 'cloud', create }],
          defaultLocation: 'cloud',
          labels: projectCreateLabels.en,
          allowDingTalkAITable: false,
          resourceSetup,
          testIds: {
            name: 'collaboration-project-name-input',
            confirm: 'collaboration-project-create-confirm',
          },
          onClose: () => {
            onClose()
            select(null)
          },
          onCreated: (project, location) => {
            onCreated(project, location)
            select(null)
            setCreated(project)
          },
        }),
      created && createElement('h1', { 'data-testid': 'cloud-project-header-title' }, created.name)
    )
  }

  await act(async () => root.render(createElement(Harness)))
  const command = vi.fn(async (action, selector, options = {}) => {
    onCommand(action, selector, options)
    if (selector === scoped('cloud-project-header-title')) {
      expect(action).toBe('waitFor')
      expect(document.querySelector(DIALOG)).toBeNull()
      expect(options).toEqual({ text: NAME, timeoutMs: UI_TIMEOUT })
    }
    const elements = [...document.querySelectorAll(selector)]
    if (action === 'getElementCount') {
      if (selector === DIALOG) firstDialogCheck.resolve()
      return String(elements.length)
    }
    if (action === 'waitFor' && options.visible === false) {
      expect(elements.filter(visible), `Still visible: ${selector}`).toHaveLength(0)
      return ''
    }
    const element = elements[0]
    expect(element, `Missing ${selector}`).toBeTruthy()
    if (options.visible) expect(visible(element), `Hidden ${selector}`).toBe(true)
    if (options.enabled || action === 'clickWhenEnabled') expect(element.disabled).not.toBe(true)
    if (options.text) expect(element.textContent).toContain(options.text)
    if (commandFailure?.action === action && commandFailure.selector === selector)
      throw commandFailure.error
    if (action === 'clickWhenEnabled') await act(async () => element.click())
    else if (action === 'fill' || action === 'select') {
      await act(async () => {
        const prototype =
          action === 'select' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, options.value)
        element.dispatchEvent(
          new Event(action === 'select' ? 'change' : 'input', { bubbles: true })
        )
      })
    } else expect(action).toBe('waitFor')
    return element.textContent ?? ''
  })
  return {
    command,
    host,
    create,
    configure,
    onClose,
    onCreated,
    firstDialogCheck: firstDialogCheck.promise,
    async open(kind = 'product') {
      expect(document.querySelector(DIALOG)).toBeNull()
      await command('clickWhenEnabled', scoped(`open-${kind}-template`), { visible: true })
      expect(document.querySelector(DIALOG)).not.toBeNull()
    },
  }
}

const openBindings = control => openTemplateProjectBindings(control, { uiTimeoutMs: UI_TIMEOUT })
const discard = control =>
  discardTemplateProjectDraft(control, {
    uiTimeoutMs: UI_TIMEOUT,
    workbenchReadyTimeoutMs: WORKBENCH_TIMEOUT,
  })
const submit = (control, beforeSubmit = vi.fn()) =>
  submitConfiguredTemplateProject(control, {
    projectName: NAME,
    uiTimeoutMs: UI_TIMEOUT,
    workbenchReadyTimeoutMs: WORKBENCH_TIMEOUT,
    beforeSubmit,
  })
const headerCalls = control =>
  control.command.mock.calls.filter(
    ([, selector]) => selector === scoped('cloud-project-header-title')
  )

async function customizeBindings(control) {
  const disclosure = get('template-customize-main').parentElement
  await act(async () => {
    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
  })
  await control.command('fill', scoped('template-group-name-main'), { value: GROUP_NAME })
  await control.command('select', scoped('template-role-main-role-0'), { value: 'human:7' })
}

test('discards the account draft before configuring and creating the next product template', async () => {
  const control = await fixture({
    onCommand(action, selector) {
      if (action !== 'waitFor' || selector !== scoped('collaboration-project-create-discard'))
        return
      expect(visible(get('collaboration-project-create-discard'))).toBe(true)
      expect(visible(get('collaboration-project-create-confirm'))).toBe(false)
      expect(visible(get('project-create-template-configuration-apply'))).toBe(false)
      expect(control.onClose).not.toHaveBeenCalled()
    },
  })
  await control.open('account')
  const originalDialog = document.querySelector(DIALOG)
  await discard(control)
  expect(originalDialog.isConnected).toBe(false)
  expect(control.onClose).toHaveBeenCalledOnce()
  expect(control.create).not.toHaveBeenCalled()
  expect(control.command.mock.calls.slice(1, 4).map(([, selector]) => selector)).toEqual([
    scoped('collaboration-project-create-cancel'),
    scoped('collaboration-project-create-discard'),
    scoped('collaboration-project-create-discard-confirm'),
  ])
  await control.open()
  expect(document.querySelector(DIALOG)).not.toBe(originalDialog)
  expect(get('collaboration-project-name-input').value).toBe(
    builtinCollaborationTemplates().find(
      record => record.document.metadata.name === 'product-lifecycle'
    ).document.spec.resources.collaboration.project.name
  )
  expect(visible(get('collaboration-project-create-confirm'))).toBe(true)
  expect(visible(get('project-create-template-configuration-apply'))).toBe(false)
  await openBindings(control)
  await customizeBindings(control)
  await submit(control)
  expect(control.create).toHaveBeenCalledOnce()
  expect(control.configure.mock.calls[0][1].template.metadata.name).toBe('product-lifecycle')
  expect(control.configure.mock.calls[0][1].collaborationGroupDrafts[0]).toEqual(
    expect.objectContaining({
      name: GROUP_NAME,
      leader: expect.objectContaining({ id: '7', kind: 'human' }),
    })
  )
  expect(control.onCreated).toHaveBeenCalledOnce()
  expect(document.querySelector(DIALOG)).toBeNull()
})

test('initial template bindings need the visible configure entry and retain edits through Apply', async () => {
  const control = await fixture()
  await control.open()
  expect(get('project-create-template-configuration').hidden).toBe(true)
  expect(visible(get('template-customize-main'))).toBe(false)
  await expect(submit(control)).rejects.toThrow('Hidden')
  expect(control.create).not.toHaveBeenCalled()
  await openBindings(control)
  expect(get('project-create-template-configuration').hidden).toBe(false)
  expect(visible(get('collaboration-project-create-confirm'))).toBe(false)
  await customizeBindings(control)
  const input = get('template-group-name-main')
  const beforeSubmit = vi.fn(() => {
    expect(get('template-group-name-main')).toBe(input)
    expect(input.value).toBe(GROUP_NAME)
    expect(get('template-role-main-role-0').value).toBe('human:7')
    expect(visible(get('project-create-template-configuration-apply'))).toBe(false)
    expect(visible(get('collaboration-project-create-confirm'))).toBe(true)
  })
  await submit(control, beforeSubmit)
  expect(beforeSubmit).toHaveBeenCalledOnce()
  expect(control.create).toHaveBeenCalledWith(expect.objectContaining({ name: NAME }))
  expect(control.configure).toHaveBeenCalledWith(
    expect.objectContaining({ name: NAME }),
    expect.objectContaining({
      collaborationGroupDrafts: [
        expect.objectContaining({
          name: GROUP_NAME,
          leader: expect.objectContaining({ id: '7', kind: 'human' }),
        }),
      ],
      template: expect.objectContaining({
        spec: expect.objectContaining({
          resources: expect.objectContaining({
            collaboration: expect.objectContaining({
              groups: [expect.objectContaining({ name: GROUP_NAME })],
            }),
          }),
        }),
      }),
    })
  )
  expect(control.onCreated).toHaveBeenCalledOnce()
  expect(document.querySelector(DIALOG)).toBeNull()
  expect(headerCalls(control)).toEqual([
    ['waitFor', scoped('cloud-project-header-title'), { text: NAME, timeoutMs: UI_TIMEOUT }],
  ])
})

test('waits for deferred real configuration beyond 10 seconds and for actual dialog unmount', async () => {
  const configuration = deferred()
  const control = await fixture({ configuration })
  await control.open()
  await openBindings(control)
  vi.useFakeTimers()
  const pending = submit(control)
  await control.firstDialogCheck
  await act(async () => vi.advanceTimersByTimeAsync(11_000))
  expect(control.create).toHaveBeenCalledOnce()
  expect(control.configure).toHaveBeenCalledOnce()
  expect(control.onCreated).not.toHaveBeenCalled()
  expect(document.querySelector(DIALOG)).not.toBeNull()
  expect(headerCalls(control)).toHaveLength(0)
  control.host.setAttribute('aria-hidden', 'true')
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(document.querySelector(scoped('collaboration-project-create-dialog'))).toBeNull()
  expect(document.querySelector(DIALOG)).not.toBeNull()
  expect(headerCalls(control)).toHaveLength(0)
  control.host.setAttribute('aria-hidden', 'false')
  await act(async () => configuration.resolve())
  await act(async () => vi.advanceTimersByTimeAsync(100))
  await pending
  expect(control.onCreated).toHaveBeenCalledOnce()
  expect(document.querySelector(DIALOG)).toBeNull()
  expect(headerCalls(control)).toHaveLength(1)
  expect(headerCalls(control)[0][2]).toEqual({ text: NAME, timeoutMs: UI_TIMEOUT })
})

test('preserves the original header assertion failure after real configuration completes', async () => {
  const original = new Error('The original header assertion failed')
  const control = await fixture({
    commandFailure: {
      action: 'waitFor',
      selector: scoped('cloud-project-header-title'),
      error: original,
    },
  })
  await control.open()
  await openBindings(control)
  await expect(submit(control)).rejects.toBe(original)
  expect(control.onCreated).toHaveBeenCalledOnce()
  expect(document.querySelector(DIALOG)).toBeNull()
})

test('rejects a missing configuration confirmation instead of claiming submission', async () => {
  const control = await fixture()
  await expect(submit(control)).rejects.toThrow('Missing')
  expect(control.create).not.toHaveBeenCalled()
  expect(control.command).toHaveBeenCalledOnce()
})

test('preserves a failed configuration confirmation and the actual binding draft', async () => {
  const original = new Error('Configuration confirmation failed')
  const control = await fixture({
    commandFailure: {
      action: 'clickWhenEnabled',
      selector: scoped('project-create-template-configuration-apply'),
      error: original,
    },
  })
  await control.open()
  await openBindings(control)
  await customizeBindings(control)
  await expect(submit(control)).rejects.toBe(original)
  expect(visible(get('project-create-template-configuration'))).toBe(true)
  expect(get('template-group-name-main').value).toBe(GROUP_NAME)
  expect(get('template-role-main-role-0').value).toBe('human:7')
  expect(control.create).not.toHaveBeenCalled()
})

test('does not discard or open another template when discard confirmation fails', async () => {
  const original = new Error('Discard confirmation failed')
  const control = await fixture({
    commandFailure: {
      action: 'clickWhenEnabled',
      selector: scoped('collaboration-project-create-discard-confirm'),
      error: original,
    },
  })
  await control.open('account')
  await expect(discard(control)).rejects.toBe(original)
  expect(visible(get('collaboration-project-create-discard'))).toBe(true)
  expect(control.onClose).not.toHaveBeenCalled()
  expect(document.querySelector(DIALOG)).not.toBeNull()
  expect(control.create).not.toHaveBeenCalled()
})

test('keeps the original completion budget and rejects real configuration that never finishes', async () => {
  const configuration = deferred()
  const control = await fixture({ configuration })
  await control.open()
  await openBindings(control)
  vi.useFakeTimers()
  const pending = expect(submit(control)).rejects.toThrow(
    'Template project configuration did not finish'
  )
  await control.firstDialogCheck
  await act(async () => vi.advanceTimersByTimeAsync(WORKBENCH_TIMEOUT))
  await pending
  expect(control.create).toHaveBeenCalledOnce()
  expect(control.configure).toHaveBeenCalledOnce()
  expect(control.onCreated).not.toHaveBeenCalled()
  expect(document.querySelector(DIALOG)).not.toBeNull()
  expect(headerCalls(control)).toHaveLength(0)
})
