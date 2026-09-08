import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadPlugin(directory) {
  const source = await readFile(new URL(`./${directory}/client.js`, import.meta.url), 'utf8')
  let handoff
  const window = {
    __ModuleLoader__: {
      load(value) {
        handoff = value
      },
    },
  }
  vm.runInNewContext(source, {
    Date,
    Error,
    URL,
    URLSearchParams,
    performance,
    window,
  })
  assert.ok(handoff)
  return handoff.factory(id => {
    assert.equal(id, 'react')
    return React
  })
}

function createRuntime() {
  const commands = []
  const configurations = new Map()
  const descriptors = []
  const keybindings = []
  const menus = []
  const references = []
  const registrations = []
  const storage = new Map()
  const browserCalls = []
  const notifications = []
  const ctx = {
    effect(factory) {
      return factory()
    },
    slots: {
      inject(_slot, factory) {
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
      commands: {
        register(_owner, definition, handler) {
          commands.push({ definition, handler })
          return () => {}
        },
      },
      composer: {
        references: {
          register(_owner, contribution) {
            references.push(contribution)
            return () => {}
          },
        },
      },
      contributions: {
        register(_owner, slot, descriptor) {
          descriptors.push({ descriptor, slot })
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
        update(id, patch) {
          const definition = configurations.get(id)
          definition.defaults = { ...definition.defaults, ...patch }
          return definition.defaults
        },
      },
      context: {
        set() {
          return () => {}
        },
      },
      host: {
        browser: {
          async closeBackgroundPage(id) {
            browserCalls.push(['close', id])
          },
          async createBackgroundPage(id) {
            browserCalls.push(['create', id])
            return { id }
          },
          async navigateBackgroundPage(id, url) {
            browserCalls.push(['navigate', id, url])
            return {
              httpResponseCode: 204,
              navigationError: null,
              title: 'Healthy endpoint',
            }
          },
        },
        notification: {
          async show(value) {
            notifications.push(value)
          },
        },
      },
      keybindings: {
        register(_owner, contribution) {
          keybindings.push(contribution)
          return () => {}
        },
      },
      localization: {
        translate(messages) {
          return messages.en
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
    browserCalls,
    commands,
    configurations,
    ctx,
    descriptors,
    keybindings,
    menus,
    notifications,
    references,
    registrations,
    storage,
  }
}

function componentFor(runtime, slot) {
  return runtime.registrations.find(entry => entry.options.name === slot)?.component
}

test('Prompt Library inserts a real template into the active Composer draft', async () => {
  const plugin = await loadPlugin('prompt-library-demo')
  const runtime = createRuntime()
  plugin.apply(runtime.ctx)

  assert.equal(runtime.commands.length, 3)
  assert.deepEqual(
    runtime.menus.map(entry => entry.location),
    ['composer.slash', 'composer.slash', 'composer.slash']
  )
  const inserted = []
  runtime.commands[0].handler(undefined, {
    composer: { insertText: value => inserted.push(value) },
    source: 'test',
  })
  assert.match(inserted[0], /正确性与边界条件/)
  assert.equal(runtime.references[0].reference, '[$Prompt Library](prompt-library://catalog)')

  const Page = componentFor(runtime, 'wework.route')
  assert.match(renderToStaticMarkup(React.createElement(Page)), /data-testid="prompt-library-page"/)
})

test('Focus Board persists work and inserts a live Markdown summary', async () => {
  const plugin = await loadPlugin('focus-board-demo')
  const runtime = createRuntime()
  plugin.apply(runtime.ctx)

  const inserted = []
  const summary = runtime.commands[0].handler(undefined, {
    composer: { insertText: value => inserted.push(value) },
    source: 'test',
  })
  assert.match(summary, /完成三个真实插件 Demo/)
  assert.equal(inserted[0], summary)
  assert.ok(componentFor(runtime, 'wework.workspace.bottom-panel.tab'))

  const Page = componentFor(runtime, 'wework.route')
  assert.match(renderToStaticMarkup(React.createElement(Page)), /data-testid="focus-board-page"/)
})

test('Sidebar Browser Panel opens one website beside the current workspace', async () => {
  const plugin = await loadPlugin('sidebar-browser-panel-demo')
  const runtime = createRuntime()
  plugin.apply(runtime.ctx)

  const panel = runtime.descriptors.find(
    entry => entry.slot === 'wework.workspace.sidebar.tab'
  )?.descriptor
  assert.deepEqual(JSON.parse(JSON.stringify(panel)), {
    id: 'reference-website',
    label: 'Reference website',
    description: 'Open the reference website beside the current workspace',
    mode: 'iframe',
    url: 'https://example.com/',
  })

  const navigation = runtime.descriptors.find(
    entry => entry.slot === 'wework.sidebar.navigation'
  )?.descriptor
  assert.equal(navigation.workspaceSidebarTab, 'reference-website')
  assert.equal(navigation.path, undefined)
  assert.equal(navigation.testId, 'sidebar-browser-panel-navigation-button')
})

test('Endpoint Watch performs a typed background-browser health check', async () => {
  const plugin = await loadPlugin('endpoint-watch-demo')
  const runtime = createRuntime()
  plugin.apply(runtime.ctx)

  const result = await runtime.commands[0].handler(undefined, { source: 'test' })
  assert.equal(result.ok, true)
  assert.equal(result.status, 204)
  assert.deepEqual(runtime.browserCalls.slice(0, 2), [
    ['create', 'plugin:endpoint-watch'],
    ['navigate', 'plugin:endpoint-watch', 'https://example.com/'],
  ])
  assert.equal(runtime.notifications[0].title, 'Endpoint Watch · 正常')
  assert.equal(runtime.menus[0].location, 'workspace.toolbar')
  assert.equal(runtime.keybindings[0].command, 'endpoint-watch.run')

  const Page = componentFor(runtime, 'wework.route')
  assert.match(renderToStaticMarkup(React.createElement(Page)), /data-testid="endpoint-watch-page"/)
})

test('Endpoint Watch reports invalid endpoint input through its normal failure path', async () => {
  const plugin = await loadPlugin('endpoint-watch-demo')
  const runtime = createRuntime()
  plugin.apply(runtime.ctx)

  const Page = componentFor(runtime, 'wework.route')
  const store = Page().props.store
  const result = await store.run('example.com', true)

  assert.equal(result.ok, false)
  assert.equal(result.endpoint, 'example.com')
  assert.equal(runtime.browserCalls.length, 0)
  assert.equal(runtime.notifications[0].title, 'Endpoint Watch · 检查失败')
})
