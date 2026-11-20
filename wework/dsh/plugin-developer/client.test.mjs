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

test('registers host-rendered plugin development surfaces with their original scopes', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let moduleRegistration
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value) {
          moduleRegistration = value
        },
      },
    },
  })
  assert.ok(moduleRegistration)

  const contributions = []
  const plugin = moduleRegistration.factory(() => {
    assert.fail('The registration client must not import the separate DSH React runtime')
  })
  plugin.apply({
    slots: {
      inject(_slot, register) {
        register()
      },
    },
    wework: {
      contributions: {
        register(_ctx, slot, descriptor) {
          contributions.push({ slot, descriptor })
          return () => {}
        },
      },
    },
  })

  assert.equal(contributions.length, 2)
  const [createAction, debugTab] = contributions
  assert.equal(createAction.slot, 'wework.plugins.action')
  assert.equal(createAction.descriptor.id, 'wework-plugin-developer.create')
  assert.equal(createAction.descriptor.labelKey, 'workbench.plugin_development_create')
  assert.equal(createAction.descriptor.module, 'plugins/wework-ui-plugin-developer-create.js')
  assert.equal(debugTab.slot, 'wework.workspace.sidebar.tab')
  assert.equal(debugTab.descriptor.id, 'wework-plugin-developer.debug')
  assert.equal(debugTab.descriptor.module, 'plugins/wework-ui-plugin-developer-debug.js')
  assert.deepEqual([...debugTab.descriptor.when.projectKinds], ['wework-core-dsh-plugin'])
  assert.equal(debugTab.descriptor.when.codexPluginKeys, undefined)
})

test('documents and demonstrates every extension point declared by the Wework host', async () => {
  const hostSource = await readFile(new URL('../app-wework/client.js', import.meta.url), 'utf8')
  const skill = await readFile(new URL('SKILL.md', pluginRoot), 'utf8')
  const catalog = await readFile(new URL('references/extension-points.md', pluginRoot), 'utf8')
  const demo = await readFile(new URL('assets/ui-extension-demo/client.js', pluginRoot), 'utf8')
  const declarationBlock = hostSource.match(
    /const SLOT_GROUPS = \{(?<body>[\s\S]*?)\r?\n    \}\r?\n    const SLOT_DECLARATIONS/
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
