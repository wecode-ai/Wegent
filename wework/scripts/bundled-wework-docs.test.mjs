import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { materializeBundledPluginResources } from './lib/bundled-plugin-resources.mjs'

const weworkRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginPath = 'wework-personal/plugins/wework-docs'

test('ships default Wework Docs with both complete documentation trees', async t => {
  const destination = await mkdtemp(join(tmpdir(), 'wework-docs-bundle-'))
  t.after(() => rm(destination, { recursive: true, force: true }))

  await materializeBundledPluginResources(weworkRoot, destination)

  const marketplace = await json(
    join(destination, 'wework-personal/.agents/plugins/marketplace.json')
  )
  const entry = marketplace.plugins.find(plugin => plugin.name === 'wework-docs')
  assert.equal(entry.policy.installation, 'INSTALLED_BY_DEFAULT')
  assert.equal(entry.source.path, './plugins/wework-docs')
  const claudeMarketplace = await json(
    join(destination, 'wework-personal/.claude-plugin/marketplace.json')
  )
  assert.equal(
    claudeMarketplace.plugins.find(plugin => plugin.name === entry.name).source,
    entry.source.path
  )

  const pluginRoot = join(destination, pluginPath)
  const manifest = await json(join(pluginRoot, '.codex-plugin/plugin.json'))
  const claudeManifest = await json(join(pluginRoot, '.claude-plugin/plugin.json'))
  assert.equal(manifest.name, entry.name)
  assert.equal(manifest.version, claudeManifest.version)
  const skillRoot = join(pluginRoot, manifest.skills, 'wework-docs')
  const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
  const routedPages = [...skill.matchAll(/\|\s+`([^`]+\.md)`\s+\|/g)].map(match => match[1])
  assert.ok(routedPages.length > 0)

  for (const language of ['zh', 'en']) {
    const source = join(weworkRoot, '..', 'docs', language, 'wework')
    const target = join(skillRoot, 'references', language)
    const files = await readdir(source, { recursive: true, withFileTypes: true })
    for (const file of files.filter(entry => entry.isFile())) {
      const relativePath = join(file.parentPath.slice(source.length + 1), file.name)
      assert.deepEqual(
        await readFile(join(target, relativePath)),
        await readFile(join(source, relativePath))
      )
    }
    for (const page of routedPages) {
      await readFile(join(target, page))
    }
  }
})

test('refreshes bundled manuals from source and removes obsolete pages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-docs-refresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'wework')
  const destination = join(root, 'output')
  const marketplaceRoot = join(sourceRoot, 'resources/bundled-plugins/wework-personal')
  await mkdir(join(sourceRoot, 'dsh'), { recursive: true })
  const manifest = JSON.stringify({ plugins: [{ name: 'wework-docs' }] })
  await file(join(marketplaceRoot, '.agents/plugins/marketplace.json'), manifest)
  await file(join(marketplaceRoot, '.claude-plugin/marketplace.json'), manifest)
  for (const language of ['zh', 'en']) {
    await file(join(root, 'docs', language, 'wework/README.md'), `${language} first edition`)
  }
  await materializeBundledPluginResources(sourceRoot, destination)
  const references = join(destination, pluginPath, 'skills/wework-docs/references')
  await file(join(references, 'zh/obsolete.md'), 'old documentation')
  await file(join(root, 'docs/zh/wework/README.md'), 'updated Chinese documentation')

  await materializeBundledPluginResources(sourceRoot, destination)

  assert.equal(
    await readFile(join(references, 'zh/README.md'), 'utf8'),
    'updated Chinese documentation'
  )
  assert.equal(await readFile(join(references, 'en/README.md'), 'utf8'), 'en first edition')
  await assert.rejects(readFile(join(references, 'zh/obsolete.md')), { code: 'ENOENT' })
})

test('refuses an incomplete documentation bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-docs-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'wework')
  const marketplaceRoot = join(sourceRoot, 'resources/bundled-plugins/wework-personal')
  const manifest = JSON.stringify({ plugins: [{ name: 'wework-docs' }] })
  await file(join(marketplaceRoot, '.agents/plugins/marketplace.json'), manifest)
  await file(join(marketplaceRoot, '.claude-plugin/marketplace.json'), manifest)
  await file(join(root, 'docs/zh/wework/README.md'), 'Chinese documentation')

  await assert.rejects(materializeBundledPluginResources(sourceRoot, join(root, 'output')), {
    code: 'ENOENT',
    path: join(root, 'docs/en/wework'),
  })
})

async function file(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
