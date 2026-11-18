import assert from 'node:assert/strict'
import { describe, expect, test, vi } from 'vitest'
import { requestContainsSkillLocator } from '../e2e/desktop/modules/desktop-server.mjs'
import {
  resolveSkillLocatorPaths,
  skillLocatorFailureSummary,
} from '../e2e/desktop/modules/skill-locator-diagnostics.mjs'

const skillName = 'create-smart-app'
const pluginName = 'smart-app-builder'
const suffix = `${pluginName}/0.1.0/skills/${skillName}/SKILL.md`
const options = skillPath => ({ skillPath, skillName, pluginName })
const catalog = (roots, locator, name = `${pluginName}:${skillName}`) =>
  `<skills_instructions>\n### Skill roots\n${roots}\n### Available skills\n- ${name}: PRIVATE_DESCRIPTION (file: ${locator})\n</skills_instructions>`

describe('failure-only fixture skill locator diagnostics', () => {
  test.each([
    ['/plugins', '- `r2` = `/plugins`', `r2/${suffix}`, `/plugins/${suffix}`],
    ['C:\\plugins', '- `r2` = `C:\\plugins`', `r2\\${suffix}`, `C:/plugins/${suffix}`],
    [
      '\\\\server\\share',
      '- `r2` = `\\\\server\\share`',
      `r2/${suffix}`,
      `//server/share/${suffix}`,
    ],
    ['/plugins', '', `/plugins/${suffix}`, `/plugins/${suffix}`],
  ])(
    'expands aliases and direct locators without changing the predicate: %s',
    (root, roots, locator, path) => {
      const expected = `${root}/${suffix}`
      const body = { input: [{ content: [{ text: catalog(roots, locator) }] }] }
      const before = structuredClone(body)
      expect(requestContainsSkillLocator(body, expected, skillName)).toBe(true)
      expect(skillLocatorFailureSummary(body, options(expected))).toEqual({
        expectedPath: path,
        skillName,
        catalogCount: 1,
        expectedPathMentionCount: roots ? 0 : 1,
        advertisedLocatorCount: 1,
        advertisedLocators: [
          { name: `${pluginName}:${skillName}`, path, matchesExpectedPath: true },
        ],
      })
      expect(body).toEqual(before)
      expect(requestContainsSkillLocator(body, expected, skillName)).toBe(true)
    }
  )

  test.each([null, '/old-plugins'])('keeps missing and wrong locators failing: %s', root => {
    const expected = `/plugins/${suffix}`
    const body = {
      input: [{ text: root ? catalog('- `r2` = `/old-plugins`', `r2/${suffix}`) : 'No catalog' }],
    }
    const before = requestContainsSkillLocator(body, expected, skillName)
    const summary = skillLocatorFailureSummary(body, options(expected))
    expect(before).toBe(false)
    expect(requestContainsSkillLocator(body, expected, skillName)).toBe(before)
    expect(summary.catalogCount).toBe(root ? 1 : 0)
    expect(summary.advertisedLocators).toEqual(
      root
        ? [
            {
              name: `${pluginName}:${skillName}`,
              path: `${root}/${suffix}`,
              matchesExpectedPath: false,
            },
          ]
        : []
    )
    assert.throws(
      () =>
        assert.ok(
          before,
          `Codex did not discover the historical plugin in its migrated native runtime: ${JSON.stringify(summary)}`
        ),
      /^AssertionError.*Codex did not discover the historical plugin in its migrated native runtime:/
    )
  })

  test('does not publish prompts, descriptions, credentials, commands, or unrelated skills', () => {
    const expected = `/plugins/${suffix}`
    const body = {
      authorization: 'PRIVATE_AUTHORIZATION',
      prompt: `PRIVATE_PROMPT mentions ${expected}`,
      arguments: { cmd: 'PRIVATE_COMMAND', token: 'PRIVATE_TOKEN' },
      input: [
        {
          text: `${catalog('- `r2` = `/plugins`', `r2/${suffix}`)}\n${catalog('- `r3` = `/PRIVATE_ROOT`', 'r3/unrelated/SKILL.md', 'PRIVATE_SKILL')}`,
        },
      ],
    }
    const summary = skillLocatorFailureSummary(body, options(expected))
    expect(summary.catalogCount).toBe(2)
    expect(summary.expectedPathMentionCount).toBe(1)
    expect(summary.advertisedLocators).toHaveLength(1)
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_')
  })

  test('reports raw path mentions separately from an advertised catalog entry', () => {
    const expected = `/plugins/${suffix}`
    const body = { input: [{ text: `<path>${expected}</path>` }] }
    expect(requestContainsSkillLocator(body, expected, skillName)).toBe(false)
    expect(skillLocatorFailureSummary(body, options(expected))).toEqual({
      expectedPath: expected,
      skillName,
      catalogCount: 0,
      expectedPathMentionCount: 1,
      advertisedLocatorCount: 0,
      advertisedLocators: [],
    })
  })

  test('resolves known and advertised fixture paths once without changing a failed predicate', async () => {
    const expected = `/plugins/${suffix}`
    const advertised = `/old-plugins/${suffix}`
    const body = { input: [{ text: catalog('- `r2` = `/old-plugins`', `r2/${suffix}`) }] }
    const summary = skillLocatorFailureSummary(body, options(expected))
    const resolve = vi.fn(async path => `/canonical${path}`)
    const resolverOptions = { pluginName, allowedRoot: '/', resolvePath: resolve }
    const resolved = await resolveSkillLocatorPaths(summary, resolverOptions)
    expect(resolve.mock.calls).toEqual([[expected], [advertised]])
    expect(resolved.expectedPathResolution).toEqual({ path: `/canonical${expected}` })
    expect(resolved.advertisedLocators[0].resolution).toEqual({ path: `/canonical${advertised}` })
    expect(requestContainsSkillLocator(body, expected, skillName)).toBe(false)
    const samePath = skillLocatorFailureSummary(
      { input: [{ text: catalog('- `r2` = `/plugins`', `r2/${suffix}`) }] },
      options(expected)
    )
    resolve.mockClear()
    await resolveSkillLocatorPaths(samePath, resolverOptions)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expected)
  })

  test.each(['ENOENT', 'EACCES', 'PRIVATE_ERROR_CODE'])(
    'reports only safe filesystem codes and keeps the original assertion failing: %s',
    async code => {
      const expected = `/plugins/${suffix}`
      const body = { input: [] }
      const summary = await resolveSkillLocatorPaths(
        skillLocatorFailureSummary(body, options(expected)),
        {
          pluginName,
          allowedRoot: '/plugins',
          resolvePath: async () => {
            throw Object.assign(new Error('PRIVATE_FILESYSTEM_MESSAGE'), { code })
          },
        }
      )
      expect(summary.expectedPathResolution).toEqual({
        errorCode: code.startsWith('PRIVATE_') ? 'UNKNOWN' : code,
      })
      expect(JSON.stringify(summary)).not.toContain('PRIVATE_')
      expect(requestContainsSkillLocator(body, expected, skillName)).toBe(false)
      assert.throws(
        () =>
          assert.ok(
            requestContainsSkillLocator(body, expected, skillName),
            `Codex did not discover the historical plugin in its migrated native runtime: ${JSON.stringify(summary)}`
          ),
        /^AssertionError.*Codex did not discover the historical plugin in its migrated native runtime:/
      )
    }
  )

  test('bounds advertised locators and never resolves unrelated or relative paths', async () => {
    const expected = `/plugins/${suffix}`
    const entries = Array.from(
      { length: 12 },
      (_, index) => `- ${pluginName}:${skillName}: Description (file: /plugins-${index}/${suffix})`
    ).join('\n')
    const summary = skillLocatorFailureSummary(
      { input: [{ text: `### Available skills\n${entries}` }] },
      options(expected)
    )
    expect(summary.advertisedLocatorCount).toBe(12)
    expect(summary.advertisedLocators).toHaveLength(8)
    const resolve = vi.fn(async path => path)
    const resolverOptions = { pluginName, allowedRoot: '/', resolvePath: resolve }
    await resolveSkillLocatorPaths(summary, resolverOptions)
    expect(resolve).toHaveBeenCalledTimes(9)
    const untrusted = skillLocatorFailureSummary(
      {
        input: [
          {
            text: catalog('', `relative/${suffix}`),
          },
          {
            text: catalog('', `/unrelated/skills/${skillName}/SKILL.md`),
          },
        ],
      },
      options(expected)
    )
    resolve.mockClear()
    const resolved = await resolveSkillLocatorPaths(untrusted, resolverOptions)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expected)
    expect(resolved.advertisedLocators.map(entry => entry.resolution)).toEqual([
      { skipped: true },
      { skipped: true },
    ])
  })

  test('includes fixture marketplace-qualified names and excludes other plugins', () => {
    const expected = `/plugins/${suffix}`
    const names = [
      `${pluginName}@wegent:${skillName}`,
      `${pluginName}@wework-personal:${skillName}`,
      `PRIVATE_OTHER_PLUGIN:${skillName}`,
    ]
    const summary = skillLocatorFailureSummary(
      { input: names.map(name => ({ text: catalog('', expected, name) })) },
      options(expected)
    )
    expect(summary.advertisedLocators.map(entry => entry.name)).toEqual(names.slice(0, 2))
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_')
  })

  test.each(['/outside', '/fixture-neighbor', 'C:/outside'])(
    'does not access metadata outside the isolated fixture Home: %s',
    async root => {
      const expected = `/fixture/${suffix}`
      const outside = `${root}/${suffix}`
      const summary = skillLocatorFailureSummary(
        { input: [{ text: catalog('', outside) }] },
        options(expected)
      )
      const resolve = vi.fn(async path => path)
      const result = await resolveSkillLocatorPaths(summary, {
        pluginName,
        allowedRoot: '/fixture',
        resolvePath: resolve,
      })
      expect(resolve).toHaveBeenCalledExactlyOnceWith(expected)
      expect(result.advertisedLocators[0].resolution).toEqual({ errorCode: 'OUTSIDE_FIXTURE_HOME' })
      const unexpected = await resolveSkillLocatorPaths(
        { ...summary, expectedPath: outside },
        {
          pluginName,
          allowedRoot: '/fixture',
          resolvePath: resolve,
        }
      )
      expect(unexpected.expectedPathResolution).toEqual({ errorCode: 'OUTSIDE_FIXTURE_HOME' })
      expect(resolve).toHaveBeenCalledTimes(1)
    }
  )

  test('reports no external canonical path when a fixture symlink escapes its Home', async () => {
    const expected = `/fixture/${suffix}`
    const result = await resolveSkillLocatorPaths(
      skillLocatorFailureSummary({ input: [] }, options(expected)),
      {
        pluginName,
        allowedRoot: '/fixture',
        resolvePath: async () => '/PRIVATE_EXTERNAL_PATH',
      }
    )
    expect(result.expectedPathResolution).toEqual({ errorCode: 'OUTSIDE_FIXTURE_HOME' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })
})
