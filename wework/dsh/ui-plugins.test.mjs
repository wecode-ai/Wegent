import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const packages = [
  'ui-core-apps',
  'ui-core-settings',
  'ui-plugin-center',
  'ui-applications',
  'ui-automations',
  'ui-cloud-work',
  'ui-git',
]

async function loadPlugin(packageName) {
  const source = await readFile(new URL(`./${packageName}/client.js`, import.meta.url), 'utf8')
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
  return { plugin: handoff.factory(() => {}), window }
}

async function registrationsOf(packageName) {
  const { plugin } = await loadPlugin(packageName)
  const registrations = []
  const injections = []
  const ctx = {
    slots: {
      inject(slot, factory) {
        injections.push(slot)
        const result = factory()
        if (result?.next) {
          for (const disposer of result) assert.equal(typeof disposer, 'function')
        }
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    wework: {
      ui: {
        register(contributionCtx, slotName, descriptor, component = () => null) {
          Object.defineProperty(component, 'wework', {
            value: Object.freeze({ ...descriptor }),
          })
          const { id, label, order, priority } = descriptor
          return contributionCtx.slots.register(
            {
              name: slotName,
              id,
              ...(label !== undefined ? { label } : {}),
              ...(order !== undefined ? { order } : {}),
              ...(priority !== undefined ? { priority } : {}),
            },
            component
          )
        },
      },
    },
  }
  plugin.apply(ctx)
  return { injections, plugin, registrations }
}

test('all Wework UI packages are standard DSH client plugins', async () => {
  for (const packageName of packages) {
    const { plugin } = await loadPlugin(packageName)
    assert.deepEqual(Array.from(plugin.inject), ['slots', 'wework'])
    assert.equal(typeof plugin.apply, 'function')
  }
})

test('core apps are contributed through wework.app', async () => {
  const { injections, registrations } = await registrationsOf('ui-core-apps')
  assert.deepEqual(injections, ['wework.app'])
  assert.deepEqual(
    registrations.map(entry => entry.options.id),
    ['wework', 'todo', 'wegent']
  )
  assert.equal(registrations[0].component.wework.module, 'plugins/wework-ui-core-apps.js')
  assert.equal(registrations[1].component.wework.module, 'plugins/wework-ui-core-apps.js')
  assert.equal(registrations[2].component.wework.urlSource, 'cloud-web')
})

test('core settings are metadata-driven DSH pages', async () => {
  const { injections, registrations } = await registrationsOf('ui-core-settings')
  assert.deepEqual(injections, ['wework.settings.page'])
  assert.equal(registrations.length, 18)
  assert.equal(registrations[0].component.wework.path, '/settings')
  assert.equal(registrations[0].component.wework.module, 'plugins/wework-ui-core-settings.js')
  assert.equal(registrations.at(-1).component.wework.module, 'plugins/wework-ui-core-settings.js')
  assert.equal('path' in registrations[0].options, false)
  assert.equal('module' in registrations[0].options, false)
})

test('first-party route packages own their routes and sidebar navigation', async () => {
  const registrations = []
  const injections = []
  for (const packageName of [
    'ui-plugin-center',
    'ui-applications',
    'ui-automations',
    'ui-cloud-work',
  ]) {
    const result = await registrationsOf(packageName)
    registrations.push(...result.registrations)
    injections.push(...result.injections)
  }
  const routes = registrations.filter(entry => entry.options.name === 'wework.route')
  const navigation = registrations.filter(
    entry => entry.options.name === 'wework.sidebar.navigation'
  )
  const actions = registrations.filter(entry => entry.options.name === 'wework.action')
  assert.deepEqual(
    routes.map(entry => entry.component.wework.path),
    ['/plugins', '/plugins/create', '/plugins/manage', '/sites', '/automations', '/cloud-work']
  )
  assert.deepEqual(
    navigation.map(entry => entry.component.wework.path),
    ['/plugins', '/sites', '/automations', '/cloud-work']
  )
  assert.equal(injections.filter(slot => slot === 'wework.sidebar.navigation').length, 4)
  assert.ok(actions.some(entry => entry.component.wework.id === 'plugin-center.open'))
  assert.ok(
    routes.every(entry => /^plugins\/wework-ui-[a-z-]+\.js$/.test(entry.component.wework.module))
  )
  assert.ok(routes.every(entry => typeof entry.component.wework.icon === 'string'))
  assert.ok(routes.every(entry => entry.component.wework.restorePolicy === 'session'))
  assert.ok(routes.every(entry => typeof entry.component.wework.title === 'string'))
  assert.ok(routes.every(entry => !('component' in entry.component.wework)))
  assert.ok(registrations.every(entry => !('path' in entry.options)))
})

test('Git contributes UI only through generic positional extension points', async () => {
  const { injections, registrations } = await registrationsOf('ui-git')
  assert.deepEqual(injections, [
    'wework.workspace.menu.section',
    'wework.project.create.section',
    'wework.project.work.section',
    'wework.runtime-profile.workspace-policy',
    'wework.task.status',
    'wework.environment.section',
    'wework.board.card.status',
    'wework.settings.page',
  ])
  assert.equal(registrations.length, 9)
  assert.deepEqual(
    registrations.slice(0, 7).map(entry => entry.options.name),
    [
      'wework.workspace.menu.section',
      'wework.project.create.section',
      'wework.project.work.section',
      'wework.runtime-profile.workspace-policy',
      'wework.task.status',
      'wework.environment.section',
      'wework.board.card.status',
    ]
  )
  assert.deepEqual(
    registrations.slice(4, 7).map(entry => entry.options.name),
    ['wework.task.status', 'wework.environment.section', 'wework.board.card.status']
  )
  assert.deepEqual(
    registrations.slice(7).map(entry => entry.options.id),
    ['git-hosting', 'worktrees']
  )
})
