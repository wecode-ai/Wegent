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
  vm.runInNewContext(source, { URLSearchParams, window })
  assert.ok(handoff)
  return handoff.factory(id => {
    assert.equal(id, 'react')
    return React
  })
}

function createPluginContext() {
  const commands = []
  const configurations = new Map()
  const composerReferences = []
  const contributions = []
  const contexts = new Map()
  const injections = []
  const keybindings = []
  const menus = []
  const registrations = []
  const storage = new Map()
  const ctx = {
    effect() {},
    slots: {
      inject(slot, factory) {
        injections.push(slot)
        const result = factory()
        if (result && Symbol.iterator in result) {
          for (const _disposer of result) {
            // Consume generator registrations like the DSH runtime.
          }
        }
      },
      register(options, component) {
        registrations.push({ component, options })
        return () => {}
      },
    },
    wework: {
      host: {},
      commands: {
        register(_owner, definition, handler) {
          commands.push({ definition, handler })
          return () => {}
        },
      },
      configuration: {
        get(id) {
          const definition = configurations.get(id)
          return definition ? { ...definition.defaults } : null
        },
        register(_owner, definition) {
          configurations.set(definition.id, definition)
          return () => {}
        },
      },
      composer: {
        references: {
          register(_owner, contribution) {
            composerReferences.push(contribution)
            return () => {}
          },
        },
      },
      contributions: {
        register(_owner, slot, descriptor) {
          contributions.push({ descriptor, slot })
          return () => {}
        },
      },
      context: {
        set(_owner, key, value) {
          contexts.set(key, value)
          return () => {}
        },
      },
      keybindings: {
        register(_owner, contribution) {
          keybindings.push(contribution)
          return () => {}
        },
      },
      menus: {
        register(_owner, location, contribution) {
          menus.push({ contribution, location })
          return () => {}
        },
      },
      storage: {
        scope(namespace) {
          return {
            get(key, fallback = null) {
              return storage.get(`${namespace}.${key}`) ?? fallback
            },
            set(key, value) {
              storage.set(`${namespace}.${key}`, value)
            },
          }
        },
      },
    },
  }
  return {
    commands,
    composerReferences,
    contributions,
    configurations,
    contexts,
    ctx,
    injections,
    keybindings,
    menus,
    registrations,
    storage,
  }
}

test('registers every public Wework UI extension point through slot injection', async () => {
  const plugin = await loadPlugin()
  const runtime = createPluginContext()

  plugin.apply(runtime.ctx)

  assert.deepEqual(Array.from(plugin.inject), ['slots', 'wework'])
  assert.deepEqual(runtime.injections, [
    'wework.action',
    'wework.app',
    'wework.task.status',
    'wework.environment.section',
    'wework.board.card.status',
    'wework.workspace.menu.section',
    'wework.composer.action',
    'wework.workspace.toolbar.action',
    'wework.workspace.bottom-panel.tab',
    'wework.plugins.action',
    'wework.project.create.section',
    'wework.project.work.section',
    'wework.runtime-profile.workspace-policy',
    'wework.route',
    'wework.sidebar.navigation',
    'wework.settings.page',
    'wework.settings.section',
    'wework.workspace.tab',
    'wework.workspace.sidebar.tab',
    'wework.shell.before',
    'wework.shell.after',
    'wework.shell.overlay',
  ])
  assert.deepEqual(
    runtime.registrations.map(entry => entry.options.name),
    runtime.injections
  )
  assert.ok(runtime.registrations.every(entry => !('path' in entry.options)))
  assert.equal(runtime.contributions.length, runtime.injections.length)
  const navigation = runtime.contributions.find(entry => entry.slot === 'wework.sidebar.navigation')
  const navigationPath = new URL(navigation.descriptor.path, 'https://wework.invalid')
  assert.equal(navigationPath.pathname, '/dsh-extension-demo')
  assert.equal(navigationPath.searchParams.get('workspaceTab'), 'auxiliary-dsh-extension-demo')
  assert.equal(navigationPath.searchParams.get('workspaceTabTitle'), 'DSH Demo')

  assert.equal(runtime.contexts.get('dsh-extension-demo.enabled'), true)
  assert.equal(runtime.composerReferences[0].reference, '[$DSH Demo](dsh-demo://overview)')
  assert.equal(
    runtime.configurations.get('dsh-extension-demo.settings').defaults.message.length > 0,
    true
  )
  assert.deepEqual(
    runtime.menus.map(entry => entry.location),
    ['composer.toolbar', 'composer.slash', 'workspace.toolbar']
  )
  assert.equal(
    JSON.stringify(runtime.keybindings),
    JSON.stringify([
      {
        command: 'dsh-extension-demo.run',
        id: 'dsh-extension-demo.run-keybinding',
        key: 'Ctrl+Shift+D',
        mac: 'Command+Shift+D',
        when: 'dsh-extension-demo.enabled',
      },
    ])
  )
  assert.equal(runtime.commands.length, 1)
  const firstRun = runtime.commands[0].handler(undefined, { source: 'test' })
  const secondRun = runtime.commands[0].handler(undefined, { source: 'test' })
  assert.equal(firstRun.runCount, 1)
  assert.equal(secondRun.runCount, 2)
  assert.equal(secondRun.message, 'Hello from the Wework extension framework')
})

test('renders the demo components without Wework-private React imports', async () => {
  const plugin = await loadPlugin()
  const runtime = createPluginContext()
  plugin.apply(runtime.ctx)
  const components = new Map(
    runtime.registrations.map(entry => [entry.options.name, entry.component])
  )

  const cases = [
    ['wework.app', { visible: true }, 'dsh-extension-demo-app'],
    ['wework.task.status', { task: { title: 'Demo task' } }, 'dsh-extension-demo-task-status'],
    [
      'wework.environment.section',
      { info: { workspacePath: '/workspace' } },
      'dsh-extension-demo-environment-section',
    ],
    ['wework.board.card.status', { itemId: 'DEMO-1' }, 'dsh-extension-demo-board-card-status'],
    [
      'wework.plugins.action',
      { onCreate() {}, t: (_key, fallback) => fallback },
      'dsh-extension-demo-plugin-action',
    ],
    ['wework.project.create.section', {}, 'dsh-extension-demo-project-create-section'],
    ['wework.project.work.section', {}, 'dsh-extension-demo-project-work-section'],
    ['wework.route', { search: '?demo=1' }, 'dsh-extension-demo-route'],
    ['wework.settings.page', {}, 'dsh-extension-demo-settings'],
    ['wework.settings.section', {}, 'dsh-extension-demo-settings-section'],
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
