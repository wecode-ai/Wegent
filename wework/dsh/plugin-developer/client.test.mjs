import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const pluginRoot = new URL('./codex-plugin/skills/develop-wework-plugin/', import.meta.url)

test('registers translated plugin development actions through the Wework service', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let moduleRegistration
  vm.runInNewContext(source, {
    Error,
    JSON,
    Object,
    String,
    console,
    fetch: async () => ({ json: async () => ({ ok: true }), ok: true }),
    window: {
      __ModuleLoader__: {
        load(value) {
          moduleRegistration = value
        },
      },
    },
  })
  assert.ok(moduleRegistration)

  const useState = value => [value, () => {}]
  const plugin = moduleRegistration.factory(specifier => {
    assert.equal(specifier, 'react')
    return {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        return { type, props: { ...props, children } }
      },
      useCallback(callback) {
        return callback
      },
      useEffect() {},
      useState,
    }
  })
  const contributions = []
  const context = {
    slots: {
      inject(_slot, register) {
        register()
      },
    },
    wework: {
      ui: {
        register(_ctx, slot, descriptor, component) {
          contributions.push({ component, descriptor, slot })
        },
      },
    },
  }

  plugin.apply(context)

  assert.equal(contributions.length, 2)
  const createAction = contributions.find(item => item.slot === 'wework.plugins.action')
  assert.ok(createAction)
  assert.equal(createAction.descriptor.labelKey, 'workbench.plugin_development_create')
  const rendered = createAction.component({
    onCreate: async () => {},
    t: (_key, fallback) => fallback,
  })
  assert.match(JSON.stringify(rendered), /wework-plugin-developer-create-button/)
  assert.match(JSON.stringify(rendered), /Create plugin/)
  const debugTab = contributions.find(item => item.slot === 'wework.workspace.sidebar.tab')
  assert.deepEqual([...debugTab.descriptor.when.projectKinds], ['wework-core-dsh-plugin'])
  assert.equal(debugTab.descriptor.when.codexPluginKeys, undefined)
  const debugPanel = debugTab.component({
    scope: { cwd: '/workspace/plugin-development-project' },
    t: (_key, fallback) => fallback,
    visible: true,
  })
  const debugMarkup = JSON.stringify(debugPanel)
  assert.match(debugMarkup, /wework-plugin-development-debug-target/)
  assert.match(debugMarkup, /Current project/)
  assert.match(debugMarkup, /Core DSH/)
  assert.match(debugMarkup, /Wework debug instance/)
  assert.match(debugMarkup, /wework-plugin-development-sidebar-start/)
  assert.doesNotMatch(debugMarkup, /wework-plugin-development-diagnostics-toggle/)
})

test('documents and demonstrates every extension point declared by the Wework host', async () => {
  const hostSource = await readFile(new URL('../app-wework/client.js', import.meta.url), 'utf8')
  const skill = await readFile(new URL('SKILL.md', pluginRoot), 'utf8')
  const catalog = await readFile(new URL('references/extension-points.md', pluginRoot), 'utf8')
  const demo = await readFile(new URL('assets/ui-extension-demo/client.js', pluginRoot), 'utf8')
  const declarationBlock = hostSource.match(/const SLOT_DECLARATIONS = \{(?<body>[\s\S]*?)\n    \}/)
    ?.groups?.body
  assert.ok(declarationBlock, 'The Wework host slot declarations could not be read')

  const extensionPoints = [...declarationBlock.matchAll(/'(wework\.[^']+)':/g)].map(
    match => match[1]
  )
  assert.ok(extensionPoints.length > 0, 'The Wework host does not declare any extension points')
  assert.match(skill, /references\/extension-points\.md/)
  assert.match(skill, /assets\/ui-extension-demo/)

  for (const extensionPoint of extensionPoints) {
    assert.match(
      catalog,
      new RegExp(`\\\`${extensionPoint.replaceAll('.', '\\.')}\\\``),
      `The plugin developer catalog does not document ${extensionPoint}`
    )
    assert.match(
      demo,
      new RegExp(`['"]${extensionPoint.replaceAll('.', '\\.')}['"]`),
      `The plugin developer demo does not cover ${extensionPoint}`
    )
  }
})

test('keeps Skill resources independent from a machine plugin cache path', async () => {
  const resources = await Promise.all(
    [
      'SKILL.md',
      'references/extension-points.md',
      'assets/ui-extension-demo/README.md',
      'assets/ui-extension-demo/README.en.md',
      'assets/ui-extension-demo/client.js',
      'assets/ui-extension-demo/package.json',
    ].map(path => readFile(new URL(path, pluginRoot), 'utf8'))
  )
  const contents = resources.join('\n')

  assert.doesNotMatch(contents, /\/Users\/[^/\s]+/)
  assert.doesNotMatch(contents, /[A-Za-z]:\\Users\\/)
  assert.doesNotMatch(contents, /(?:~\/)?\.wework\/codex\/plugins\/cache/)
  assert.doesNotMatch(contents, /plugins\/cache\/(?:wework|wework-personal)/)
  assert.match(contents, /\[references\/extension-points\.md]\(references\/extension-points\.md\)/)
  assert.match(contents, /\[assets\/ui-extension-demo]\(assets\/ui-extension-demo\)/)
})
