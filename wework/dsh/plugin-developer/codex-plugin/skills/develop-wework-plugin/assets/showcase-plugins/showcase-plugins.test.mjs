import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildTestCommands, discoverTests } from './quality-guardian-demo/index.js'
import { inspectEnvironment, prepareEnvironment } from './runtime-doctor-demo/index.js'
import { analyzeWorkspace } from './workspace-copilot-demo/index.js'

const DEMOS = [
  ['workspace-copilot-demo', 'workspace-copilot.action', 'workspace-copilot-trigger'],
  ['quality-guardian-demo', 'test-explorer.sidebar', 'test-explorer'],
  ['runtime-doctor-demo', 'dev-environments.status', 'dev-environments-trigger'],
]

test('ships three independently installable showcase plugins', async () => {
  for (const [directory, contributionId, testId] of DEMOS) {
    const root = new URL(`./${directory}/`, import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
    const readme = await readFile(new URL('README.md', root), 'utf8')
    const client = await loadClient(directory)
    const registrations = []
    const commands = []
    const providers = []
    client.apply(createClientContext(registrations, commands, providers))

    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.match(patch, /weworkPluginRuntime/)
    assert.ok(registrations.some(entry => entry.id === contributionId))
    assert.ok(providers.length > 0)
    assert.match(readme, /Public contracts demonstrated/)
    const Component = registrations.find(entry => entry.id === contributionId).component
    assert.match(
      renderToStaticMarkup(
        React.createElement(Component, {
          scope: { cwd: '/tmp/workspace' },
          workspaceTarget: { path: '/tmp/workspace' },
        })
      ),
      new RegExp(`data-testid="${testId}"`)
    )
  }
})

test('Workspace Copilot analyzes real repository signals', async () => {
  const fixture = await workspaceFixture()
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      scripts: { test: 'vitest', lint: 'eslint .' },
      dependencies: { next: '1.0.0', react: '1.0.0' },
    })
  )
  await mkdir(join(fixture, 'src'))
  await writeFile(join(fixture, 'src', 'page.tsx'), 'export const Page = () => null\n')
  const report = await analyzeWorkspace({ cwd: fixture })
  assert.equal(report.root.length > 0, true)
  assert.deepEqual(report.frameworks, ['Next.js', 'React'])
  assert.equal(report.languages[0].label, 'TypeScript')
  await rm(fixture, { recursive: true, force: true })
})

test('Workspace Copilot localizes visible copy through the public host service', async () => {
  const client = await loadClient('workspace-copilot-demo')
  const registrations = []
  client.apply(createClientContext(registrations, [], [], 'en-US'))
  const Component = registrations.find(entry => entry.id === 'workspace-copilot.action').component

  assert.match(
    renderToStaticMarkup(
      React.createElement(Component, {
        workspaceTarget: { path: '/tmp/workspace' },
      })
    ),
    /aria-label="Open Workspace Copilot"/
  )
})

test('Test Explorer discovers real test files and groups their frameworks', async () => {
  const fixture = await workspaceFixture()
  await mkdir(join(fixture, 'tests'))
  await writeFile(join(fixture, 'tests', 'widget.test.ts'), 'test("widget", () => {})\n')
  await writeFile(join(fixture, 'tests', 'test_api.py'), 'def test_api():\n    assert True\n')
  const report = await discoverTests({ cwd: fixture })
  assert.equal(report.count, 2)
  assert.deepEqual(report.frameworks.sort(), ['Pytest', 'Test runner'])
  assert.deepEqual(
    report.tests.map(test => test.path),
    ['tests/test_api.py', 'tests/widget.test.ts']
  )
  await rm(fixture, { recursive: true, force: true })
})

test('Test Explorer builds separate commands for mixed Python and JavaScript tests', async () => {
  const fixture = await workspaceFixture()
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest run' } })
  )

  const commands = await buildTestCommands(fixture, [
    { framework: 'Pytest', path: 'tests/test_api.py' },
    { framework: 'Test runner', path: 'tests/widget.test.ts' },
  ])

  assert.deepEqual(commands, [
    {
      file: 'python3',
      args: ['-m', 'pytest', '-q', 'tests/test_api.py'],
    },
    {
      file: 'npm',
      args: ['test', '--', '--run', 'tests/widget.test.ts'],
    },
  ])
  await rm(fixture, { recursive: true, force: true })
})

test('Dev Environments detects and creates a bounded Dev Container configuration', async () => {
  const fixture = await workspaceFixture()
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ engines: { node: '>=20' }, packageManager: 'pnpm@11' })
  )
  const report = await inspectEnvironment({ cwd: fixture })
  assert.equal(report.state, 'local')
  assert.equal(report.recommendation.label, 'Node.js 22')
  const prepared = await prepareEnvironment({ cwd: fixture, target: 'devcontainer' })
  assert.equal(prepared.state, 'configured')
  assert.equal(prepared.created, true)
  const configuration = JSON.parse(
    await readFile(join(fixture, '.devcontainer', 'devcontainer.json'), 'utf8')
  )
  assert.match(configuration.image, /typescript-node/)
  const existing = await prepareEnvironment({ cwd: fixture, target: 'devcontainer' })
  assert.equal(existing.created, false)
  await rm(fixture, { recursive: true, force: true })
})

async function workspaceFixture() {
  return mkdtemp(join(tmpdir(), 'wework-showcase-'))
}

async function loadClient(directory) {
  const source = await readFile(new URL(`./${directory}/client.js`, import.meta.url), 'utf8')
  let registration
  vm.runInNewContext(source, {
    Error,
    URLSearchParams,
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
  })
  return registration.factory(id => {
    assert.equal(id, 'react')
    return React
  })
}

function createClientContext(registrations, commands, providers, locale = 'zh-CN') {
  const context = {
    slots: {
      inject(_slot, factory) {
        const result = factory()
        if (result && Symbol.iterator in result) {
          for (const _disposer of result) {
            // Consume lifecycle registrations like the DSH runtime.
          }
        }
      },
      register(options, component) {
        registrations.push({ ...options, component })
        return () => {}
      },
    },
    wework: {
      backend: {
        scope() {
          return { request: async () => ({}) }
        },
      },
      commands: {
        register(_owner, definition, handler) {
          commands.push({ definition, handler })
          return () => {}
        },
      },
      menus: {
        register() {
          return () => {}
        },
      },
      localization: {
        getLocale() {
          return locale
        },
        translate(messages, fallback = '') {
          if (typeof messages === 'string') return messages
          const language = locale.split('-')[0]
          return (
            messages[locale] ?? messages[language] ?? messages.en ?? messages['zh-CN'] ?? fallback
          )
        },
      },
      composer: {
        focus() {},
        insertText() {},
      },
      contributions: {
        register() {
          return () => {}
        },
      },
      chat: createProviderService('chat', providers),
      testing: createProviderService('testing', providers),
      environments: createProviderService('environments', providers),
    },
  }
  context.wework.chat.prepareContext = (id, request) =>
    context.wework.chat.providers.get(id).prepareContext(request)
  context.wework.testing.discover = (id, request) =>
    context.wework.testing.providers.get(id).discover(request)
  context.wework.testing.run = (id, request) =>
    context.wework.testing.providers.get(id).run(request)
  context.wework.environments.inspect = (id, request) =>
    context.wework.environments.providers.get(id).inspect(request)
  context.wework.environments.prepare = (id, request) =>
    context.wework.environments.providers.get(id).prepare(request)
  return context
}

function createProviderService(kind, providers) {
  const entries = new Map()
  return {
    providers: {
      register(_owner, provider) {
        providers.push({ kind, provider })
        entries.set(provider.id, provider)
        return () => entries.delete(provider.id)
      },
      get(id) {
        return entries.get(id)
      },
      list() {
        return [...entries.values()]
      },
    },
  }
}
