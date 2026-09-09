import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const codexPluginRoot = new URL('./codex-plugin/', import.meta.url)
const pluginRoot = new URL('skills/develop-wework-plugin/', codexPluginRoot)

test('publishes a cache-invalidating official Codex plugin version', async () => {
  const outerManifest = JSON.parse(
    await readFile(new URL('./package.json', import.meta.url), 'utf8')
  )
  const codexManifest = JSON.parse(
    await readFile(new URL('.codex-plugin/plugin.json', codexPluginRoot), 'utf8')
  )

  assert.equal(outerManifest.version, '0.1.9')
  assert.equal(codexManifest.version, '0.1.9')
  assert.deepEqual(Object.keys(codexManifest), [
    'name',
    'version',
    'description',
    'author',
    'skills',
    'interface',
  ])
})

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
  const descriptors = new Map()
  const context = {
    slots: {
      inject(_slot, register) {
        const result = register()
        if (result && Symbol.iterator in result) {
          for (const _disposer of result) {
            // Consume generator registrations like the DSH runtime.
          }
        }
      },
      register(options, component) {
        contributions.push({
          component,
          descriptor: descriptors.get(`${options.name}:${options.id}`),
          slot: options.name,
        })
        return () => {}
      },
    },
    wework: {
      contributions: {
        register(_ctx, slot, descriptor) {
          descriptors.set(`${slot}:${descriptor.id}`, descriptor)
          return () => {}
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
  assert.match(debugMarkup, /grid grid-cols-2 bg-background/)
  assert.match(debugMarkup, /col-span-2 flex min-w-0 items-center/)
  assert.match(debugMarkup, /whitespace-nowrap bg-text-primary/)
  assert.doesNotMatch(debugMarkup, /wework-plugin-development-diagnostics-toggle/)
})

test('documents and demonstrates every extension point declared by the Wework host', async () => {
  const hostSource = await readFile(new URL('../app-wework/client.js', import.meta.url), 'utf8')
  const skill = await readFile(new URL('SKILL.md', pluginRoot), 'utf8')
  const catalog = await readFile(new URL('references/extension-points.md', pluginRoot), 'utf8')
  const demo = await readFile(new URL('assets/ui-extension-demo/client.js', pluginRoot), 'utf8')
  const declarationBlock = hostSource.match(
    /const SLOT_GROUPS = \{(?<body>[\s\S]*?)\n    \}\n    const SLOT_DECLARATIONS/
  )?.groups?.body
  assert.ok(declarationBlock, 'The Wework host slot declarations could not be read')

  const extensionPoints = [...declarationBlock.matchAll(/'(wework\.[^']+)':/g)]
    .map(match => match[1])
    .filter(name => !name.startsWith('wework.internal.'))
  assert.ok(extensionPoints.length > 0, 'The Wework host does not declare any extension points')
  assert.match(skill, /references\/extension-points\.md/)
  assert.match(skill, /assets\/ui-extension-demo/)
  assert.match(skill, /assets\/reference-plugins/)
  assert.match(skill, /assets\/showcase-plugins/)
  assert.match(skill, /invocation\.composer/)
  assert.match(skill, /Never edit files inside an installed plugin cache/)
  assert.match(skill, /official `\.codex-plugin\/plugin\.json` format/)
  assert.match(skill, /wework desktop inspect --project \./)
  assert.match(skill, /required\s+control surface/)
  assert.match(skill, /Do not bypass\s+the CLI/)
  assert.match(skill, /It does not create a tab/)
  assert.match(catalog, /replaces that tab's whole surface/)
  assert.match(skill, /Open a route in its own workspace tab/)
  assert.match(skill, /Omitting `workspaceTab` intentionally replaces the active/)
  assert.match(catalog, /Workspace-tab navigation protocol/)
  assert.match(catalog, /If the ID does not exist, Wework creates a tab/)
  assert.match(demo, /workspaceTabPath/)
  assert.match(demo, /auxiliary-dsh-extension-demo/)

  for (const extensionPoint of extensionPoints) {
    assert.match(
      skill,
      new RegExp(`\\\`${extensionPoint.replaceAll('.', '\\.')}\\\``),
      `The primary Skill does not name ${extensionPoint}`
    )
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
      'assets/reference-plugins/README.md',
      'assets/reference-plugins/prompt-library-demo/README.md',
      'assets/reference-plugins/focus-board-demo/README.md',
      'assets/reference-plugins/sidebar-browser-panel-demo/README.md',
      'assets/reference-plugins/endpoint-watch-demo/README.md',
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
  assert.match(contents, /\[assets\/reference-plugins]\(assets\/reference-plugins\)/)
})

test('ships focused executable reference plugin packages', async () => {
  const directories = [
    'prompt-library-demo',
    'focus-board-demo',
    'sidebar-browser-panel-demo',
    'endpoint-watch-demo',
  ]

  for (const directory of directories) {
    const root = new URL(`assets/reference-plugins/${directory}/`, pluginRoot)
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
    const client = await readFile(new URL('client.js', root), 'utf8')

    assert.match(manifest.name, /^@wegent\/dsh-/)
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.match(patch, /@wegent\/dsh-/)
    assert.match(client, /window\.__ModuleLoader__\.load/)
  }
})

test('ships a minimal website panel reference without an unrelated nested Codex plugin', async () => {
  const root = new URL('assets/reference-plugins/sidebar-browser-panel-demo/', pluginRoot)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const client = await readFile(new URL('client.js', root), 'utf8')

  assert.equal(manifest.wework, undefined)
  assert.deepEqual(manifest.files, ['README.md', 'client.js', 'cordis.patch.yml', 'index.js'])
  assert.match(client, /'wework\.workspace\.sidebar\.tab'/)
  assert.match(client, /'wework\.sidebar\.navigation'/)
  assert.match(client, /mode:\s*'iframe'/)
  assert.match(client, /workspaceSidebarTab:\s*PANEL_ID/)
  assert.doesNotMatch(client, /'wework\.app'/)
})

test('ships three product-oriented showcase plugin packages', async () => {
  const directories = ['workspace-copilot-demo', 'quality-guardian-demo', 'runtime-doctor-demo']

  for (const directory of directories) {
    const root = new URL(`assets/showcase-plugins/${directory}/`, pluginRoot)
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    const backend = await readFile(new URL('index.js', root), 'utf8')
    const client = await readFile(new URL('client.js', root), 'utf8')

    assert.match(manifest.name, /^@wegent\/dsh-/)
    assert.match(backend, /weworkPluginRuntime\.register/)
    assert.match(client, /ctx\.wework\.backend\.scope/)
  }
})
