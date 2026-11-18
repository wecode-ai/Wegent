// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { requestContainsSkillLocator } from '../e2e/desktop/modules/desktop-server.mjs'
import {
  describeTargetSkillCatalog,
  readSkillCatalogs,
} from '../e2e/desktop/modules/target-skill-catalog-evidence.mjs'

const expectedSkillName = 'smart-app-builder:create-smart-app'
const expectedPath =
  '/native/plugins/cache/wegent/smart-app-builder/0.1.0/skills/create-smart-app/SKILL.md'
const catalog = (root, entries) => `<skills_instructions>
### Skill roots
- \`r0\` = \`${root}\`
### Available skills
${entries}
</skills_instructions>`
const target = locator =>
  `- smart-app-builder:create-smart-app: Target description. (file: ${locator})`
const locator = 'r0/smart-app-builder/0.1.0/skills/create-smart-app/SKILL.md'
const describe = body =>
  describeTargetSkillCatalog(body, {
    expectedSkillName,
    expectedPath,
    parserResult: requestContainsSkillLocator(body, expectedPath),
  })

test('projects the target alias and expanded path from the latest catalog', () => {
  const body = {
    instructions: catalog('/stale', target(locator)),
    input: [
      {
        role: 'developer',
        content: [
          { type: 'input_text', text: catalog('/native/plugins/cache/wegent', target(locator)) },
        ],
      },
    ],
  }
  assert.deepEqual(describe(body), {
    expectedSkillName,
    expectedPath,
    parserResult: true,
    catalogCount: 2,
    rootCount: 1,
    skillCount: 1,
    targetCount: 1,
    targets: [
      {
        name: 'smart-app-builder:create-smart-app',
        locator,
        rootAlias: 'r0',
        rootPath: '/native/plugins/cache/wegent',
        expandedPath: expectedPath,
      },
    ],
  })
})

test('an empty latest catalog supersedes earlier target evidence without changing the parser', () => {
  const body = {
    input: [
      {
        role: 'user',
        content: catalog('/native/plugins/cache/wegent', target(locator)) + catalog('/current', ''),
      },
    ],
  }
  const evidence = describe(body)
  assert.equal(evidence.catalogCount, 2)
  assert.equal(evidence.targetCount, 0)
  assert.deepEqual(evidence.targets, [])
  assert.equal(evidence.parserResult, true)
})

test.each(['C:\\native', '\\\\server\\native'])(
  'expands Windows aliases at %s and preserves their observed locator spelling',
  windowsRoot => {
    const windowsPath = `${windowsRoot}\\smart-app-builder\\0.1.0\\skills\\create-smart-app\\SKILL.md`
    const windowsLocator = 'r0\\smart-app-builder\\0.1.0\\skills\\create-smart-app\\SKILL.md'
    const body = { instructions: catalog(windowsRoot, target(windowsLocator)) }
    const evidence = describeTargetSkillCatalog(body, {
      expectedSkillName,
      expectedPath: windowsPath,
      parserResult: requestContainsSkillLocator(body, windowsPath),
    })
    assert.equal(evidence.parserResult, true)
    assert.equal(evidence.targets[0].locator, windowsLocator)
    assert.equal(evidence.targets[0].rootPath, windowsRoot)
    assert.equal(evidence.targets[0].expandedPath, windowsPath.replaceAll('\\', '/'))
  }
)

test('reports absent targets and never includes unrelated skills, roots, prompts or credentials', () => {
  const secret = 'must-never-appear-in-evidence'
  const body = {
    authorization: secret,
    instructions: secret,
    input: [
      {
        role: 'developer',
        content: catalog(
          `/private/${secret}`,
          `- private:other-skill: ${secret} (file: r0/${secret}/SKILL.md)`
        ),
      },
      { role: 'tool', content: catalog('/quoted', target(locator)) },
      { role: 'user', content: secret },
    ],
  }
  const evidence = describe(body)
  assert.equal(evidence.catalogCount, 1)
  assert.equal(evidence.skillCount, 1)
  assert.equal(evidence.targetCount, 0)
  assert.equal(evidence.parserResult, false)
  assert.ok(!JSON.stringify(evidence).includes(secret))
  assert.ok(!JSON.stringify(evidence).includes('other-skill'))
  assert.equal(requestContainsSkillLocator(body, expectedPath), false)
})

test('a request without a skills block yields only empty counts and expected identity', () => {
  assert.deepEqual(describe({ input: [] }).targets, [])
  assert.equal(describe({ input: [] }).catalogCount, 0)
  assert.equal(describe({ input: [] }).parserResult, false)
})

test('shared hot-update extraction preserves message order, role filtering and empty updates', () => {
  const block = text => `<skills_instructions>${text}</skills_instructions>`
  const body = {
    instructions: block('instructions'),
    input: [
      { role: 'system', content: block('system') },
      { role: 'developer', content: [{ text: block('developer') }] },
      { role: 'user', content: block('user') + block('') },
      { role: 'assistant', content: block('ignored assistant') },
      { role: 'tool', content: block('ignored tool') },
    ],
  }
  assert.deepEqual(readSkillCatalogs(body), ['instructions', 'system', 'developer', 'user', ''])
  assert.equal(readSkillCatalogs(body).at(-1), '')
  assert.deepEqual(readSkillCatalogs({ input: [] }), [])
})

test('target evidence excludes descriptions and same-name skills in another plugin', () => {
  const secret = 'private-content-must-not-leak'
  const body = {
    instructions: catalog(
      '/native/plugins/cache/wegent',
      target(locator).replace('Target description.', secret) +
        `\n- private:create-smart-app: ${secret} (file: /private/${secret}/SKILL.md)`
    ),
  }
  const original = structuredClone(body)
  const evidence = describe(body)
  assert.equal(evidence.targetCount, 1)
  assert.equal(evidence.skillCount, 2)
  assert.ok(!JSON.stringify(evidence).includes(secret))
  assert.deepEqual(body, original)
})
