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
  let registration
  const context = {
    provide(name, value) {
      this[name] = value
    },
    slots: {
      register(options, component) {
        registration = { options, component }
      },
    },
  }

  assert.deepEqual(Array.from(client.exports.inject), ['slots'])
  client.exports.apply(context)
  assert.equal(registration.options.name, 'root')
  assert.equal(registration.options.priority, -100)
  assert.equal(
    JSON.stringify(registration.options.children),
    JSON.stringify({
      'wework.action': { kind: 'list', scope: 'root' },
      'wework.app': { kind: 'list', scope: 'root' },
      'wework.board.card.status': { kind: 'list', scope: 'root' },
      'wework.environment.section': { kind: 'list', scope: 'root' },
      'wework.project.create.section': { kind: 'list', scope: 'root' },
      'wework.project.work.section': { kind: 'list', scope: 'root' },
      'wework.route': { kind: 'list', scope: 'root' },
      'wework.runtime-profile.workspace-policy': { kind: 'list', scope: 'root' },
      'wework.settings.page': { kind: 'list', scope: 'root' },
      'wework.sidebar.navigation': { kind: 'list', scope: 'root' },
      'wework.shell.after': { kind: 'list', scope: 'root' },
      'wework.shell.before': { kind: 'list', scope: 'root' },
      'wework.shell.overlay': { kind: 'list', scope: 'root' },
      'wework.task.status': { kind: 'list', scope: 'root' },
      'wework.workspace.menu.section': { kind: 'list', scope: 'root' },
      'wework.workspace.sidebar.tab': { kind: 'list', scope: 'root' },
      'wework.workspace.tab': { kind: 'list', scope: 'root' },
    })
  )
  assert.equal(typeof registration.component, 'function')
})

test('projects native DSH sidebar slot entries into Wework containers', async () => {
  const client = await loadClient()
  let registration
  const context = {
    provide(name, value) {
      this[name] = value
    },
    slots: {
      register(options, component) {
        registration = { options, component }
      },
      entriesOfSlot() {
        const component = () => null
        component.wework = { icon: 'search', placement: 'secondary' }
        return [
          {
            component,
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
  const renderCalls = []
  const Root = registration.component
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
  const projected = Root({
    renderSlot(name, owner, options) {
      renderCalls.push({ name, props: owner, options })
      return { name, owner, options }
    },
  })
  const portal = projected.props.children[1]
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

test('registers Wework descriptors on standard DSH slot components', async () => {
  const client = await loadClient()
  const registrations = []
  const ctx = {
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
  ctx.wework.ui.register(ctx, 'wework.workspace.tab', descriptor, Component)

  assert.equal(registrations.length, 2)
  assert.equal(
    JSON.stringify(registrations[1].options),
    JSON.stringify({
      name: 'wework.workspace.tab',
      id: 'quality-dashboard',
      label: 'Quality dashboard',
      order: 20,
    })
  )
  assert.equal(registrations[1].component, Component)
  assert.equal(JSON.stringify(Component.wework), JSON.stringify(descriptor))
  assert.equal(Object.isFrozen(Component.wework), true)
})

test('projects native DSH workspace tab entries into Wework surfaces', async () => {
  const client = await loadClient()
  let registration
  const context = {
    provide(name, value) {
      this[name] = value
    },
    slots: {
      register(options, component) {
        registration = { options, component }
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
  const Root = registration.component
  Root({ renderSlot: () => null })
  const cleanup = client.effects[0]()
  assert.equal(
    JSON.stringify(client.hostWindow.__WEWORK_DSH_UI__.getEntries('wework.workspace.tab')),
    JSON.stringify([{ id: 'dashboard', label: 'Dashboard', order: 5 }])
  )

  const container = {}
  const props = { visible: true, tab: { id: 'workspace-1' } }
  client.hostWindow.__WEWORK_DSH_UI__.attach('wework.workspace.tab', 'dashboard', container, props)
  const rendered = Root({
    renderSlot(name, owner, options) {
      return { name, owner, options }
    },
  })
  const portal = rendered.props.children[1]
  assert.equal(portal.container, container)
  assert.equal(portal.node.name, 'wework.workspace.tab')
  assert.equal(portal.node.owner, props)
  assert.equal(portal.node.options.only, 'dashboard')
  cleanup()
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
