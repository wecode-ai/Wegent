import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadPlugin() {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let handoff
  const window = {
    __ModuleLoader__: {
      load(value) {
        handoff = value
      },
    },
  }
  vm.runInNewContext(source, { window })
  assert.ok(handoff)
  return handoff.factory(id => {
    assert.equal(id, 'react')
    return React
  })
}

test('registers every public Wework UI extension point through slot injection', async () => {
  const plugin = await loadPlugin()
  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(slot, factory) {
        injections.push(slot)
        factory()
      },
      register(options, component) {
        registrations.push({ component, options })
        return () => {}
      },
    },
    wework: {
      ui: {
        register(contributionCtx, slot, descriptor, component = () => null) {
          Object.defineProperty(component, 'wework', {
            value: Object.freeze({ ...descriptor }),
          })
          return contributionCtx.slots.register(
            {
              name: slot,
              id: descriptor.id,
              ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
              ...(descriptor.order === undefined ? {} : { order: descriptor.order }),
            },
            component
          )
        },
      },
    },
  }

  plugin.apply(ctx)

  assert.deepEqual(Array.from(plugin.inject), ['slots', 'wework'])
  assert.deepEqual(injections, [
    'wework.action',
    'wework.app',
    'wework.task.status',
    'wework.environment.section',
    'wework.board.card.status',
    'wework.workspace.menu.section',
    'wework.route',
    'wework.sidebar.navigation',
    'wework.settings.page',
    'wework.workspace.tab',
    'wework.workspace.sidebar.tab',
    'wework.shell.before',
    'wework.shell.after',
    'wework.shell.overlay',
  ])
  assert.deepEqual(
    registrations.map(entry => entry.options.name),
    injections
  )
  assert.ok(
    registrations.every(
      entry => !('path' in entry.options) && Object.isFrozen(entry.component.wework)
    )
  )
})

test('renders the demo components without Wework-private React imports', async () => {
  const plugin = await loadPlugin()
  const components = new Map()
  const ctx = {
    slots: {
      inject(_slot, factory) {
        factory()
      },
      register(options, component) {
        components.set(options.name, component)
        return () => {}
      },
    },
    wework: {
      ui: {
        register(contributionCtx, slot, descriptor, component = () => null) {
          Object.defineProperty(component, 'wework', {
            value: Object.freeze({ ...descriptor }),
          })
          return contributionCtx.slots.register({ name: slot, id: descriptor.id }, component)
        },
      },
    },
  }
  plugin.apply(ctx)

  const cases = [
    ['wework.app', { visible: true }, 'dsh-extension-demo-app'],
    ['wework.task.status', { task: { title: 'Demo task' } }, 'dsh-extension-demo-task-status'],
    [
      'wework.environment.section',
      { info: { workspacePath: '/workspace' } },
      'dsh-extension-demo-environment-section',
    ],
    ['wework.board.card.status', { itemId: 'DEMO-1' }, 'dsh-extension-demo-board-card-status'],
    ['wework.route', { search: '?demo=1' }, 'dsh-extension-demo-route'],
    ['wework.settings.page', {}, 'dsh-extension-demo-settings'],
    [
      'wework.workspace.tab',
      { tab: { id: 'tab-1' }, visible: true },
      'dsh-extension-demo-workspace-tab',
    ],
    [
      'wework.workspace.sidebar.tab',
      { scope: { cwd: '/workspace' }, tab: { title: 'Inspector' }, visible: true },
      'dsh-extension-demo-workspace-sidebar',
    ],
    ['wework.shell.before', {}, 'dsh-extension-demo-shell-before'],
    ['wework.shell.after', {}, 'dsh-extension-demo-shell-after'],
    ['wework.shell.overlay', {}, 'dsh-extension-demo-overlay'],
  ]
  for (const [slot, props, testId] of cases) {
    const Component = components.get(slot)
    assert.equal(typeof Component, 'function', `${slot} did not register a component`)
    assert.match(renderToStaticMarkup(React.createElement(Component, props)), new RegExp(testId))
  }
})
