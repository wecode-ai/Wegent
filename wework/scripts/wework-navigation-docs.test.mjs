import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const slots = ['wework.settings.page', 'wework.sidebar.navigation']
const page = 'interface-navigation.md'

// Evaluate the actual registration declarations, including loops and spreads,
// rather than maintaining another hand-written list of navigation entries.
async function registeredNavigation() {
  const entries = []
  const directories = await readdir(join(root, 'dsh'), { withFileTypes: true })
  for (const directory of directories.filter(
    entry => entry.isDirectory() && entry.name.startsWith('ui-')
  )) {
    const path = join(root, 'dsh', directory.name, 'client.js')
    const source = await readFile(path, 'utf8')
    let plugin
    runInNewContext(
      source,
      {
        window: { __ModuleLoader__: { load: declaration => (plugin = declaration.factory()) } },
      },
      { filename: path, timeout: 1000 }
    )
    plugin.apply({
      slots: {
        inject(_slot, register) {
          const result = register()
          if (result?.[Symbol.iterator]) Array.from(result)
        },
      },
      wework: {
        contributions: {
          register(_ctx, slot, entry) {
            if (slots.includes(slot)) entries.push({ slot, ...entry })
          },
        },
      },
    })
  }
  for (const slot of slots)
    assert.ok(
      entries.some(entry => entry.slot === slot),
      slot
    )
  return entries
}

function validateIndex(document, entries, translations, language) {
  const rows = document.split('\n').filter(line => /^\|.*`\/[^`]*`\s*\|$/.test(line))
  const routeOf = row => row.match(/`(\/[^`]*)`\s*\|$/)[1]
  assert.deepEqual(
    rows.map(routeOf).sort(),
    entries.map(entry => entry.path).sort(),
    `${language}: missing, duplicate or obsolete navigation routes`
  )
  const categories = new Map(
    entries
      .filter(entry => entry.categoryLabelKey)
      .map(entry => [entry.category, translations.workbench[entry.categoryLabelKey]])
  )
  for (const entry of entries) {
    const row = rows.find(candidate => routeOf(candidate) === entry.path)
    const key = entry.labelKey?.replace(/^workbench\./, '')
    const label = translations.workbench[key] ?? entry.label
    const clickPath = row.split('|')[1].trim()
    assert.ok(clickPath.endsWith(`→ ${label}`), `${language}: label for ${entry.path}`)
    if (entry.category) {
      assert.equal(clickPath, `${categories.get(entry.category)} → ${label}`)
    }
    const desktop = language === 'zh' ? '；仅桌面' : '; desktop only'
    const experimental = language === 'zh' ? '；实验性功能' : '; experimental'
    assert.equal(row.includes(desktop), Boolean(entry.desktopOnly), entry.path)
    assert.equal(row.includes(experimental), Boolean(entry.experimental), entry.path)
  }
}

test('both navigation indexes cover registered settings/sidebar entries and current labels', async () => {
  const entries = await registeredNavigation()
  for (const [language, locale] of [
    ['zh', 'zh-CN'],
    ['en', 'en'],
  ]) {
    const docs = join(root, '..', 'docs', language, 'wework')
    const document = await readFile(join(docs, page), 'utf8')
    const translations = JSON.parse(
      await readFile(join(root, 'src/i18n/locales', locale, 'common.json'))
    )
    validateIndex(document, entries, translations, language)
    assert.ok((await readFile(join(docs, 'README.md'), 'utf8')).includes(`](./${page})`))
    for (const [, link, anchor] of document.matchAll(/\]\((\.\/[^)#]+)(?:#([^)]*))?\)/g)) {
      const topic = await readFile(join(docs, link), 'utf8')
      if (anchor)
        assert.ok(
          topic.includes(`<a id="${anchor}"></a>`),
          `${language}: missing feature anchor ${link}#${anchor}`
        )
    }
  }
  const skill = await readFile(
    join(
      root,
      'resources/bundled-plugins/wework-personal/plugins/wework-docs/skills/wework-docs/SKILL.md'
    ),
    'utf8'
  )
  assert.ok(skill.includes(`\`${page}\``), 'the skill must route location questions to the index')
})

test('navigation coverage rejects omissions, obsolete entries, renamed labels and visibility drift', () => {
  const entry = {
    path: '/settings/example',
    category: 'personal',
    categoryLabelKey: 'group',
    labelKey: 'example',
    desktopOnly: true,
    experimental: true,
  }
  const translations = { workbench: { group: 'Personal', example: 'Example' } }
  const row =
    '| Personal → Example | Example settings; desktop only; experimental | `/settings/example` |'
  validateIndex(row, [entry], translations, 'en')
  for (const invalid of [
    '',
    `${row}\n${row}`,
    row.replace('/example', '/removed'),
    row.replace('Example', 'Old name'),
    row.replace('Personal', 'Other'),
    row.replace('desktop only', ''),
    row.replace('experimental', ''),
  ]) {
    assert.throws(() => validateIndex(invalid, [entry], translations, 'en'))
  }
  assert.throws(() => validateIndex(row, [], translations, 'en'))
  assert.throws(() => validateIndex(row, [entry, { ...entry, path: '/new' }], translations, 'en'))
})

// This checks literal labels used by the current JSX field convention, not
// arbitrary rendered UI. Dynamic labels and nested controls still need review.
function literalFieldKeys(source, includeObjectLabels = false) {
  const expressions = [/\slabel=\{\s*t\(\s*(['"])([^'"]+)\1/g]
  if (includeObjectLabels) expressions.push(/\blabel:\s*t\(\s*(['"])([^'"]+)\1/g)
  return [...new Set(expressions.flatMap(pattern => [...source.matchAll(pattern)].map(m => m[2])))]
}

function assertFieldCoverage(document, source, translations, context, includeObjectLabels) {
  const body = document.replace(/<!--[\s\S]*?-->/g, '')
  for (const key of literalFieldKeys(source, includeObjectLabels)) {
    const label = key.split('.').reduce((value, segment) => value?.[segment], translations)
    assert.equal(typeof label, 'string', `${context}: missing translation for ${key}`)
    assert.ok(body.includes(label), `${context}: document field "${label}" (${key})`)
  }
}

test('every desktop and shared collaboration page has a bilingual topic owner and documented literal fields', async () => {
  const sources = []
  for (const sourceRoot of ['src', '../packages/collaboration/src']) {
    const files = await readdir(join(root, sourceRoot), { recursive: true })
    sources.push(
      ...files
        .filter(path => path.endsWith('Page.tsx'))
        .map(path => `${sourceRoot}/${path.replaceAll('\\', '/')}`)
    )
  }
  const ownersByLanguage = []
  for (const [language, locale] of [
    ['zh', 'zh-CN'],
    ['en', 'en'],
  ]) {
    const docsRoot = join(root, '..', 'docs', language, 'wework')
    const files = (await readdir(docsRoot, { recursive: true })).filter(path =>
      path.endsWith('.md')
    )
    const translations = JSON.parse(
      await readFile(join(root, 'src/i18n/locales', locale, 'common.json'))
    )
    const owners = new Map()
    for (const file of files) {
      const document = await readFile(join(docsRoot, file), 'utf8')
      for (const [, sourcePath] of document.matchAll(/<!-- ui-source: ([^\s]+) -->/g)) {
        assert.ok(!owners.has(sourcePath), `${language}: duplicate topic owner for ${sourcePath}`)
        owners.set(sourcePath, file.replaceAll('\\', '/'))
        const source = await readFile(join(root, sourcePath), 'utf8')
        assertFieldCoverage(
          document,
          source,
          translations,
          `${language}/${file}: ${sourcePath}`,
          sourcePath.endsWith('/GeneralSettingsPage.tsx')
        )
      }
    }
    for (const source of sources)
      assert.ok(owners.has(source), `${language}: missing topic owner for ${source}`)
    ownersByLanguage.push([...owners].sort(([a], [b]) => a.localeCompare(b)))
  }
  assert.deepEqual(
    ownersByLanguage[0],
    ownersByLanguage[1],
    'Chinese and English must use the same topic owners'
  )
})

test('field coverage detects missing or renamed controls without counting metadata as instructions', () => {
  const source = `<SettingsRow label={t('workbench.feature')} /><button aria-label={t('workbench.other')} />`
  const translations = { workbench: { feature: 'Feature', other: 'Other' } }
  assert.deepEqual(literalFieldKeys(source), ['workbench.feature'])
  assertFieldCoverage('Feature: choose its option.', source, translations, 'fixture')
  assert.throws(() => assertFieldCoverage('<!-- Feature -->', source, translations, 'fixture'))
  assert.throws(() => assertFieldCoverage('Old name', source, translations, 'fixture'))
  assert.throws(() => assertFieldCoverage('Feature', source, { workbench: {} }, 'fixture'))
})
