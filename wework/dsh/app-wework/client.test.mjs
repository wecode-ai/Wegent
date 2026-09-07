import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadClient() {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let registration
  const listeners = new Map()
  const hostWindow = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
    addEventListener(name, listener) {
      listeners.set(name, listener)
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name)
    },
  }
  vm.runInNewContext(source, {
    Error,
    Object,
    Promise,
    String,
    Symbol,
    console,
    window: hostWindow,
  })
  assert.ok(registration)

  const effects = []
  const refs = []
  const exports = registration.factory(specifier => {
    if (specifier === 'react-dom') {
      return {
        createPortal(node, container, key) {
          return { node, container, key }
        },
      }
    }
    if (specifier !== 'react') throw new Error(`Unexpected module: ${specifier}`)
    return {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        return { type, props: { ...props, children } }
      },
      useEffect(effect) {
        effects.push(effect)
      },
      useRef(value) {
        const ref = { current: value }
        refs.push(ref)
        return ref
      },
      useState(value) {
        return [value, () => {}]
      },
    }
  })
  return { effects, exports, hostWindow, listeners, refs }
}

test('registers Wework as the DSH root application', async () => {
  const client = await loadClient()
  const registrations = []
  const context = {
    effect(factory) {
      return factory()
    },
    provide(name, value) {
      this[name] = value
    },
    slots: {
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    weworkDesktop: {
      dialog: {},
    },
  }

  assert.deepEqual(Array.from(client.exports.inject), ['slots', 'weworkDesktop'])
  client.exports.apply(context)
  assert.equal(context.wework.host, context.weworkDesktop)
  assert.equal(context.wework.ui, undefined)
  const registration = registrations.find(entry => entry.options.name === 'root')
  assert.equal(registration.options.name, 'root')
  assert.equal(registration.options.priority, -100)
  assert.equal(
    JSON.stringify(registration.options.children),
    JSON.stringify({
      'wework.internal.catalog': { kind: 'single', scope: 'root' },
      'wework.internal.shell': { kind: 'single', scope: 'root' },
      'wework.internal.workspace': { kind: 'single', scope: 'root' },
    })
  )
  assert.equal(registrations.length, 4)
  const workspaceGroup = registrations.find(
    entry => entry.options.name === 'wework.internal.workspace'
  )
  assert.equal(workspaceGroup.options.children['wework.composer.action'].scope, 'session-maybe')
  assert.equal(workspaceGroup.options.children['wework.workspace.tab'].scope, 'session-maybe')
  assert.equal(workspaceGroup.options.children['wework.task.status'].scope, 'root')
  assert.equal(typeof registration.component, 'function')
})

test('projects native DSH sidebar slot entries into Wework containers', async () => {
  const client = await loadClient()
  const registrations = []
  const context = {
    effect(factory) {
      return factory()
    },
    provide(name, value) {
      this[name] = value
    },
    slots: {
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
      entriesOfSlot() {
        return [
          {
            component: () => null,
            options: { id: 'inspector', label: 'Inspector', order: 20 },
          },
        ]
      },
      subscribe() {
        return () => {}
      },
    },
  }
  client.exports.apply(context)
  context.wework.contributions.register(context, 'wework.workspace.sidebar.tab', {
    id: 'inspector',
    icon: 'search',
    placement: 'secondary',
  })
  const renderCalls = []
  const Root = registrations.find(entry => entry.options.name === 'root').component
  const WorkspaceGroup = registrations.find(
    entry => entry.options.name === 'wework.internal.workspace'
  ).component
  Root({
    renderSlot(name, props, options) {
      renderCalls.push({ name, props, options })
      return { name, props, options }
    },
  })
  const cleanup = client.effects[0]()
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(client.hostWindow.__WEWORK_DSH_UI__.getEntries('wework.workspace.sidebar.tab'))
    ),
    [
      {
        icon: 'search',
        placement: 'secondary',
        id: 'inspector',
        label: 'Inspector',
        order: 20,
      },
    ]
  )

  const container = {}
  const props = { visible: true }
  const mounted = client.hostWindow.__WEWORK_DSH_UI__.attach(
    'wework.workspace.sidebar.tab',
    'inspector',
    container,
    props
  )
  Root({
    renderSlot() {
      return null
    },
  })
  const projected = WorkspaceGroup({
    renderSlot(name, owner, options) {
      renderCalls.push({ name, props: owner, options })
      return { name, owner, options }
    },
    revision: 1,
  })
  const portal = projected.props.children[0]
  assert.equal(portal.container, container)
  assert.equal(
    JSON.stringify(renderCalls.at(-1)),
    JSON.stringify({
      name: 'wework.workspace.sidebar.tab',
      props,
      options: { only: 'inspector' },
    })
  )

  mounted.dispose()
  cleanup()
})

test('keeps descriptors separate from native DSH slot components', async () => {
  const client = await loadClient()
  const registrations = []
  const ctx = {
    effect(factory) {
      return factory()
    },
    provide(name, value) {
      this[name] = value
    },
    slots: {
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  const Component = () => null
  const descriptor = {
    id: 'quality-dashboard',
    label: 'Quality dashboard',
    order: 20,
    path: '/quality',
    telemetryFeature: 'quality',
  }

  client.exports.apply(ctx)
  ctx.wework.contributions.register(ctx, 'wework.workspace.tab', descriptor)
  ctx.slots.register(
    {
      name: 'wework.workspace.tab',
      id: descriptor.id,
      label: descriptor.label,
      order: descriptor.order,
    },
    Component
  )

  assert.equal(registrations.length, 5)
  assert.equal(
    JSON.stringify(registrations[4].options),
    JSON.stringify({
      name: 'wework.workspace.tab',
      id: 'quality-dashboard',
      label: 'Quality dashboard',
      order: 20,
    })
  )
  assert.equal(registrations[4].component, Component)
  assert.equal(Component.wework, undefined)
  assert.equal(ctx.wework.contributions.get('wework.workspace.tab', descriptor.id).path, '/quality')
})

test('rejects unnamed bottom-panel contributions at registration', async () => {
  const client = await loadClient()
  const runtime = client.exports.createExtensionRuntime()
  const owner = { effect: factory => factory() }

  assert.throws(
    () =>
      runtime.service.contributions.register(owner, 'wework.workspace.bottom-panel.tab', {
        id: 'quality.bottom-panel',
        label: ' ',
      }),
    /Bottom panel contribution label must be a non-empty string/
  )
})

test('projects native DSH workspace tab entries into Wework surfaces', async () => {
  const client = await loadClient()
  const registrations = []
  const context = {
    effect(factory) {
      return factory()
    },
    provide(name, value) {
      this[name] = value
    },
    slots: {
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
      entriesOfSlot(name) {
        return name === 'wework.workspace.tab'
          ? [{ options: { id: 'dashboard', label: 'Dashboard', order: 5 } }]
          : []
      },
      subscribe() {
        return () => {}
      },
    },
  }
  client.exports.apply(context)
  const Root = registrations.find(entry => entry.options.name === 'root').component
  const WorkspaceGroup = registrations.find(
    entry => entry.options.name === 'wework.internal.workspace'
  ).component
  Root({ renderSlot: () => null })
  const cleanup = client.effects[0]()
  assert.equal(
    JSON.stringify(client.hostWindow.__WEWORK_DSH_UI__.getEntries('wework.workspace.tab')),
    JSON.stringify([{ id: 'dashboard', label: 'Dashboard', order: 5 }])
  )

  const container = {}
  const props = { visible: true, tab: { id: 'workspace-1' } }
  client.hostWindow.__WEWORK_DSH_UI__.attach('wework.workspace.tab', 'dashboard', container, props)
  Root({ renderSlot: () => null })
  const rendered = WorkspaceGroup({
    renderSlot(name, owner, options) {
      return { name, owner, options }
    },
    revision: 1,
  })
  const portal = rendered.props.children[0]
  assert.equal(portal.container, container)
  assert.equal(portal.node.name, 'wework.workspace.tab')
  assert.equal(portal.node.owner, props)
  assert.equal(portal.node.options.only, 'dashboard')
  cleanup()
})

test('registers scoped commands and removes them with their Cordis owner', async () => {
  const client = await loadClient()
  const runtime = client.exports.createExtensionRuntime()
  const cleanups = []
  const owner = {
    effect(factory) {
      const cleanup = factory()
      cleanups.push(cleanup)
      return cleanup
    },
  }

  const calls = []
  runtime.service.commands.register(
    owner,
    {
      id: 'quality.refresh',
      title: 'Refresh quality',
      enablement: { key: 'workspace.ready', equals: true },
    },
    async (args, invocation) => {
      calls.push({ args, invocation })
      return 'refreshed'
    }
  )

  await assert.rejects(runtime.service.commands.execute('quality.refresh'), /Command is disabled/)
  runtime.service.context.set(owner, 'workspace.ready', true)
  assert.equal(
    await runtime.service.commands.execute(
      'quality.refresh',
      { full: true },
      { commandId: 'spoofed.command', source: 'keybinding' }
    ),
    'refreshed'
  )
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([
      {
        args: { full: true },
        invocation: { source: 'keybinding', commandId: 'quality.refresh' },
      },
    ])
  )

  for (const cleanup of cleanups.reverse()) cleanup()
  assert.equal(runtime.service.commands.get('quality.refresh'), null)
  assert.equal(runtime.service.context.get('workspace.ready'), undefined)
})

test('calls lifecycle-safe plugin backends through the shared runtime', async () => {
  const client = await loadClient()
  const calls = []
  const runtime = client.exports.createExtensionRuntime({
    fetch: async (path, options) => {
      calls.push([path, JSON.parse(options.body)])
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { languages: ['TypeScript'] } }
        },
      }
    },
  })

  const backend = runtime.service.backend.scope('workspace-copilot')
  assert.equal(
    JSON.stringify(await backend.request('analyze', { cwd: '/workspace' })),
    JSON.stringify({ languages: ['TypeScript'] })
  )
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([
      [
        '/wework/plugins/v1/rpc',
        {
          plugin: 'workspace-copilot',
          method: 'analyze',
          params: { cwd: '/workspace' },
        },
      ],
    ])
  )

  runtime.dispose()
  await assert.rejects(backend.request('analyze'), /disposed/)
})

test('filters menus and keybindings through shared context expressions', async () => {
  const client = await loadClient()
  const runtime = client.exports.createExtensionRuntime()
  const owner = {
    effect(factory) {
      return factory()
    },
  }

  runtime.service.commands.register(
    owner,
    { id: 'workspace.inspect', title: 'Inspect workspace' },
    () => {}
  )
  runtime.service.menus.register(owner, 'workspace.title', {
    id: 'workspace.inspect.menu',
    command: 'workspace.inspect',
    order: 20,
    when: { all: ['workspace.ready', { key: 'workspace.kind', equals: 'local' }] },
    enablement: { key: 'workspace.writable', equals: true },
  })
  runtime.service.keybindings.register(owner, {
    id: 'workspace.inspect.keybinding',
    command: 'workspace.inspect',
    key: 'Command+Shift+I',
    when: 'workspace.ready',
  })

  assert.equal(runtime.service.menus.list('workspace.title').length, 0)
  assert.equal(runtime.service.keybindings.list().length, 0)
  runtime.service.context.set(owner, 'workspace.ready', true)
  runtime.service.context.set(owner, 'workspace.kind', 'local')
  assert.equal(runtime.service.menus.list('workspace.title')[0].enabled, false)
  assert.equal(runtime.service.keybindings.list().length, 1)
  runtime.service.context.set(owner, 'workspace.writable', true)
  assert.equal(runtime.service.menus.list('workspace.title')[0].enabled, true)
})

test('localizes standalone plugin copy without private Wework imports', async () => {
  const client = await loadClient()
  let locale = 'zh-CN'
  const runtime = client.exports.createExtensionRuntime({ locale: () => locale })

  assert.equal(runtime.service.localization.getLocale(), 'zh-CN')
  assert.equal(runtime.service.localization.translate({ en: 'Refresh', 'zh-CN': '刷新' }), '刷新')
  locale = 'en-US'
  assert.equal(
    runtime.service.localization.translate({ en: 'Refresh', 'zh-CN': '刷新' }),
    'Refresh'
  )
  locale = 'zh'
  assert.equal(runtime.service.localization.translate({ en: 'Refresh', 'zh-CN': '刷新' }), '刷新')
  assert.equal(runtime.service.localization.translate({ fr: 'Actualiser' }, 'Fallback'), 'Fallback')
})

test('restores overlapping context contributions regardless of disposal order', async () => {
  const client = await loadClient()
  const runtime = client.exports.createExtensionRuntime()
  const owner = { effect: factory => factory() }

  const disposeFirst = runtime.service.context.set(owner, 'workspace.mode', 'first')
  const disposeSecond = runtime.service.context.set(owner, 'workspace.mode', 'second')
  assert.equal(runtime.service.context.get('workspace.mode'), 'second')

  disposeFirst()
  assert.equal(runtime.service.context.get('workspace.mode'), 'second')
  disposeSecond()
  assert.equal(runtime.service.context.get('workspace.mode'), undefined)
})

test('publishes searchable composer references through shared context', async () => {
  const client = await loadClient()
  const runtime = client.exports.createExtensionRuntime()
  const owner = {
    effect(factory) {
      return factory()
    },
  }

  runtime.service.composer.references.register(owner, {
    id: 'quality.report',
    title: 'Quality report',
    reference: '[$Quality](quality://report)',
    when: 'workspace.ready',
    enablement: 'workspace.writable',
  })

  assert.equal(runtime.service.composer.references.list().length, 0)
  runtime.service.context.set(owner, 'workspace.ready', true)
  assert.equal(runtime.service.composer.references.list()[0].enabled, false)
  runtime.service.context.set(owner, 'workspace.writable', true)
  assert.equal(runtime.service.composer.references.list()[0].enabled, true)
  assert.equal(
    runtime.service.composer.references.list()[0].reference,
    '[$Quality](quality://report)'
  )
})

test('registers lifecycle-scoped chat, testing, and environment providers', async () => {
  const client = await loadClient()
  const runtime = client.exports.createExtensionRuntime()
  const cleanups = []
  const owner = {
    effect(factory) {
      const cleanup = factory()
      cleanups.push(cleanup)
      return cleanup
    },
  }

  runtime.service.chat.providers.register(owner, {
    id: 'assistant',
    label: 'Assistant',
    async prepareContext(request) {
      return { text: `Context for ${request.workspacePath}` }
    },
  })
  runtime.service.testing.providers.register(owner, {
    id: 'tests',
    label: 'Tests',
    async discover(request) {
      return { path: request.workspacePath, tests: ['unit'] }
    },
    async run(request) {
      return { state: 'passed', testIds: request.testIds }
    },
  })
  runtime.service.environments.providers.register(owner, {
    id: 'containers',
    label: 'Containers',
    async inspect(request) {
      return { path: request.workspacePath, state: 'local' }
    },
    async prepare(request) {
      return { path: request.workspacePath, state: request.target }
    },
  })

  assert.equal(
    (await runtime.service.chat.prepareContext('assistant', { workspacePath: '/workspace' })).text,
    'Context for /workspace'
  )
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await runtime.service.testing.discover('tests', { workspacePath: '/workspace' })
      )
    ),
    { path: '/workspace', tests: ['unit'] }
  )
  assert.equal(
    (
      await runtime.service.environments.prepare('containers', {
        workspacePath: '/workspace',
        target: 'devcontainer',
      })
    ).state,
    'devcontainer'
  )

  for (const cleanup of cleanups) cleanup()
  assert.equal(runtime.service.chat.providers.list().length, 0)
  assert.equal(runtime.service.testing.providers.list().length, 0)
  assert.equal(runtime.service.environments.providers.list().length, 0)
})

test('binds the active Composer without exposing a second editor registry', async () => {
  const client = await loadClient()
  const runtime = client.exports.createExtensionRuntime()
  let value = 'before'
  let focused = false
  const dispose = runtime.service.composer.bind({
    focus() {
      focused = true
    },
    getValue() {
      return value
    },
    insertText(text) {
      value += text
    },
    setValue(next) {
      value = next
    },
  })

  assert.equal(runtime.service.composer.getValue(), 'before')
  runtime.service.composer.insertText(' after')
  runtime.service.composer.focus()
  assert.equal(value, 'before after')
  assert.equal(focused, true)
  runtime.service.composer.setValue('replaced')
  assert.equal(value, 'replaced')
  dispose()
  assert.throws(() => runtime.service.composer.insertText('missing'), /No active Wework composer/)
})

test('provides namespaced state, validated configuration, and secure values', async () => {
  const client = await loadClient()
  const values = new Map()
  const secureCalls = []
  const runtime = client.exports.createExtensionRuntime({
    secureStorage: {
      get: async key => {
        secureCalls.push(['get', key])
        return 'secret'
      },
      set: async (key, value) => {
        secureCalls.push(['set', key, value])
      },
      delete: async key => {
        secureCalls.push(['delete', key])
      },
    },
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  })
  const owner = {
    effect(factory) {
      return factory()
    },
  }

  const state = runtime.service.storage.scope('quality')
  state.set('last-run', { passed: 4 })
  assert.equal(JSON.stringify(state.get('last-run')), JSON.stringify({ passed: 4 }))
  values.set('wework.plugin.quality.corrupted', '{invalid')
  assert.equal(state.get('corrupted', 'fallback'), 'fallback')

  runtime.service.configuration.register(owner, {
    id: 'quality',
    title: 'Quality',
    defaults: { threshold: 80 },
    validate(value) {
      if (value.threshold < 0) throw new Error('Threshold is invalid')
    },
  })
  values.set('wework.plugin.configuration.quality', '{invalid')
  assert.equal(runtime.service.configuration.get('quality').threshold, 80)
  assert.equal(runtime.service.configuration.update('quality', { threshold: 90 }).threshold, 90)
  assert.throws(
    () => runtime.service.configuration.update('quality', { threshold: -1 }),
    /Threshold is invalid/
  )

  const secrets = runtime.service.secrets.scope('quality')
  assert.equal(await secrets.get('token'), 'secret')
  await secrets.set('token', 'updated')
  await secrets.delete('token')
  assert.equal(
    JSON.stringify(secureCalls),
    JSON.stringify([
      ['get', 'quality.token'],
      ['set', 'quality.token', 'updated'],
      ['delete', 'quality.token'],
    ])
  )
})

test('mounts the Wework bundle with the active DSH context', async () => {
  const client = await loadClient()
  const context = { slots: {} }
  const disposeCalls = []
  const container = {}
  client.hostWindow.__WEWORK_APP_RUNTIME__ = {
    async mount(target, receivedContext) {
      assert.equal(target, container)
      assert.equal(receivedContext, context)
      return () => disposeCalls.push('disposed')
    },
  }

  context.slots.entriesOfSlot = () => []
  context.slots.subscribe = () => () => {}
  const Root = client.exports.createWeworkRoot(context, client.hostWindow)
  const element = Root({ renderSlot: () => null })
  const appRoot = element.props.children[0]
  assert.equal(appRoot.props['data-testid'], 'wework-dsh-root')
  appRoot.props.ref.current = container
  const cleanup = client.effects[0]()
  await Promise.resolve()
  cleanup()
  assert.deepEqual(disposeCalls, ['disposed'])
})

test('waits for the Wework application bundle when it loads after DSH plugins', async () => {
  const client = await loadClient()
  const context = { slots: {} }
  const container = {}
  let mounted = false
  context.slots.entriesOfSlot = () => []
  context.slots.subscribe = () => () => {}
  const Root = client.exports.createWeworkRoot(context, client.hostWindow)
  const element = Root({ renderSlot: () => null })
  element.props.children[0].props.ref.current = container
  const cleanup = client.effects[0]()

  assert.equal(client.listeners.has(client.exports.APP_RUNTIME_READY_EVENT), true)
  client.hostWindow.__WEWORK_APP_RUNTIME__ = {
    async mount() {
      mounted = true
      return () => {}
    },
  }
  client.listeners.get(client.exports.APP_RUNTIME_READY_EVENT)()
  await Promise.resolve()
  assert.equal(mounted, true)
  cleanup()
})
