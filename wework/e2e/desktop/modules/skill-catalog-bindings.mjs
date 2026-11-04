import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { commandOutputAsync, repoDir } from './shared.mjs'

// Exercise the release publisher against the same real MySQL and management
// APIs as the desktop checkpoint, including an alias produced by the old release.
export async function verifySkillCatalogBindings(cloud, resultDir, request) {
  assert.equal(new URL(cloud.backendUrl).hostname, '127.0.0.1')
  const names = ['catalog-binding-source', 'catalog-binding-renamed', 'catalog-binding-created']
  const root = join(resultDir, 'skill-catalog-bindings')
  for (const name of names) {
    const directory = join(root, name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Catalog binding lifecycle fixture\n---\nCatalog binding lifecycle fixture\n`
    )
  }
  const catalogPath = join(root, 'catalog.json')
  await writeFile(
    catalogPath,
    JSON.stringify({
      assets: names.map(name => ({
        name,
        source: 'fixture',
        path: name,
        bind_shells: ['ClaudeCode', 'Codex'],
      })),
      expansions: { [names[0]]: names.slice(1) },
    })
  )
  const publish = async () =>
    JSON.parse(
      await commandOutputAsync(
        'uv',
        [
          'run',
          'python',
          'scripts/publish_skill_catalog.py',
          catalogPath,
          '--source',
          `fixture=${root}`,
          '--apply',
        ],
        { cwd: join(repoDir, 'backend'), env: cloud.backendEnv }
      )
    )
  const initial = await publish()
  const ids = names.map(name => initial.assets[name])
  let aliasFixture
  let testFailed = false
  try {
    const source = await request(`v1/kinds/skills/${ids[0]}/bindings/me`, 'POST')
    const renamed = await request(`v1/kinds/skills/${ids[1]}/bindings/me`, 'POST')
    const exceptions = [{ type: 'project', value: 'catalog-excluded-project' }]
    await request(`v1/kinds/skills/${ids[1]}/bindings/me`, 'PATCH', {
      exceptions,
      force_preload: true,
    })
    const alias = `catalog-${source.id}-skill-${ids[1]}`
    const ownerId = Number(source.target_id.replace(/^user:/, ''))
    assert.ok(Number.isInteger(ownerId) && ownerId > 0)
    await cloud.executeDatabase(
      "UPDATE kinds SET name = %s, `json` = JSON_SET(`json`, '$.metadata.name', %s) WHERE id = %s AND user_id = %s AND kind = 'SkillBinding'",
      [alias, alias, renamed.id, ownerId]
    )
    aliasFixture = { alias, bindingId: renamed.id, ownerId }
    const stored = await cloud.queryDatabase('SELECT name FROM kinds WHERE id = %s', [renamed.id])
    assert.equal(stored[0]?.name, alias, 'The fixture must reproduce the previous release state')

    await publish()
    const bindings = await request('v1/kinds/skills/bindings/me')
    const restored = bindings.find(binding => binding.skill_ref.skill_id === ids[1])
    const created = bindings.find(binding => binding.skill_ref.skill_id === ids[2])
    assert.equal(restored?.id, renamed.id, 'Repair must retain the binding identity')
    assert.equal(restored.force_preload, true)
    assert.deepEqual(restored.exceptions, exceptions)
    assert.ok(created?.id, 'Publication must create the missing destination binding')

    for (const [id, binding] of [
      [ids[1], restored],
      [ids[2], created],
    ]) {
      const updated = await request(`v1/kinds/skills/${id}/bindings/me`, 'PATCH', {
        exceptions: [],
        force_preload: false,
      })
      assert.equal(updated.id, binding.id)
      assert.equal(updated.force_preload, false)
      await request(`v1/kinds/skills/${id}/bindings/me`, 'DELETE')
    }
    assert.deepEqual((await publish()).bindings, [], 'Publication must preserve removal')
    const disabled = await request('v1/kinds/skills/bindings/me')
    assert.equal(
      disabled.some(binding => ids.slice(1).includes(binding.skill_ref.skill_id)),
      false
    )
    for (const [id, binding] of [
      [ids[1], restored],
      [ids[2], created],
    ]) {
      const enabled = await request(`v1/kinds/skills/${id}/bindings/me`, 'POST')
      assert.equal(enabled.id, binding.id, 'Restoration must reuse the existing binding')
    }
    await writeFile(
      join(root, 'verified.json'),
      JSON.stringify({ passed: true, assets: initial.assets, repairedBindingId: renamed.id })
    )
  } catch (error) {
    testFailed = true
    throw error
  } finally {
    const cleanupFailures = []
    const clean = async (label, action) => {
      try {
        await action()
      } catch (error) {
        console.error(`[desktop-e2e] skill catalog cleanup failed (${label}):`, error)
        cleanupFailures.push(error)
      }
    }
    if (aliasFixture) {
      await clean('legacy alias', () =>
        cloud.executeDatabase(
          "UPDATE kinds SET is_active = 0 WHERE id = %s AND user_id = %s AND name = %s AND kind = 'SkillBinding'",
          [aliasFixture.bindingId, aliasFixture.ownerId, aliasFixture.alias]
        )
      )
    }
    for (const id of ids) {
      await clean(`binding ${id}`, () => request(`v1/kinds/skills/${id}/bindings/me`, 'DELETE'))
    }
    if (!testFailed && cleanupFailures.length) {
      throw new AggregateError(cleanupFailures, 'Skill catalog binding cleanup failed')
    }
  }
}
