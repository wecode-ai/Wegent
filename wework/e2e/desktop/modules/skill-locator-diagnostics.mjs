import { realpath } from 'node:fs/promises'
import { posix } from 'node:path'

const MAX_LOCATORS = 8
const FILESYSTEM_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'ELOOP',
  'EINVAL',
  'ENAMETOOLONG',
  'EIO',
])

function normalizePath(value) {
  const path = value.replaceAll('\\', '/')
  return `${path.startsWith('//') ? '/' : ''}${posix.normalize(path)}`
}

function* nestedStrings(value) {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) {
    for (const item of value) yield* nestedStrings(item)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) yield* nestedStrings(item)
  }
}

/** Inspect only fixture skill locators; never return model messages or other request fields. */
export function skillLocatorFailureSummary(body, { skillPath, skillName, pluginName }) {
  const expectedPath = normalizePath(skillPath)
  const fixtureNames = new Set([
    skillName,
    `${pluginName}:${skillName}`,
    `${pluginName}@wegent:${skillName}`,
    `${pluginName}@wework-personal:${skillName}`,
  ])
  const advertisedLocators = []
  let advertisedLocatorCount = 0
  let catalogCount = 0
  let expectedPathMentionCount = 0
  for (const text of nestedStrings(body)) {
    if (text.replaceAll('\\', '/').includes(expectedPath)) expectedPathMentionCount++
    const roots = new Map()
    let section = null
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (/^#{1,6} /u.test(line) || /^<\/?skills_instructions>/u.test(line)) {
        section =
          line === '### Skill roots' ? 'roots' : line === '### Available skills' ? 'skills' : null
        if (section === 'skills') catalogCount++
        if (section === 'roots' || /^#{1,2} |^<\/?skills_instructions>/u.test(line)) roots.clear()
        continue
      }
      if (section === 'roots') {
        const root = line.match(/^- `([^`]+)` = `([^`]+)`$/u)
        if (root) roots.set(root[1], root[2])
      }
      if (section !== 'skills') continue
      const entry = line.match(/^- (.+?): .+ \(file: (.+)\)$/u)
      if (!entry || !fixtureNames.has(entry[1])) continue
      const locator = entry[2].replaceAll('\\', '/')
      const separator = locator.indexOf('/')
      const root = roots.get(locator.slice(0, separator))
      const path = normalizePath(root ? `${root}/${locator.slice(separator + 1)}` : locator)
      if (!path.endsWith(`/${skillName}/SKILL.md`)) continue
      advertisedLocatorCount++
      if (advertisedLocators.length < MAX_LOCATORS)
        advertisedLocators.push({
          name: entry[1],
          path,
          matchesExpectedPath: path === expectedPath,
        })
    }
  }
  return {
    expectedPath,
    skillName,
    catalogCount,
    expectedPathMentionCount,
    advertisedLocatorCount,
    advertisedLocators,
  }
}

function isInsideFixtureHome(path, allowedRoot) {
  let root = normalizePath(allowedRoot).replace(/\/$/u, '')
  if (/^(?:[A-Za-z]:\/|\/\/)/u.test(root)) {
    root = root.toLowerCase()
    path = path.toLowerCase()
  }
  return path === root || path.startsWith(`${root}/`)
}

/** Resolve only the known fixture path and bounded locators inside its isolated Home. */
export async function resolveSkillLocatorPaths(
  summary,
  { pluginName, allowedRoot, resolvePath = realpath }
) {
  const resolutions = new Map()
  const resolve = path => {
    if (!resolutions.has(path))
      resolutions.set(
        path,
        (async () => {
          if (!isInsideFixtureHome(path, allowedRoot)) return { errorCode: 'OUTSIDE_FIXTURE_HOME' }
          try {
            const canonical = normalizePath(await resolvePath(path))
            return isInsideFixtureHome(canonical, allowedRoot)
              ? { path: canonical }
              : { errorCode: 'OUTSIDE_FIXTURE_HOME' }
          } catch (error) {
            return {
              errorCode: FILESYSTEM_ERROR_CODES.has(error?.code) ? error.code : 'UNKNOWN',
            }
          }
        })()
      )
    return resolutions.get(path)
  }
  return {
    ...summary,
    expectedPathResolution: await resolve(summary.expectedPath),
    advertisedLocators: await Promise.all(
      summary.advertisedLocators.slice(0, MAX_LOCATORS).map(async entry => ({
        ...entry,
        resolution:
          /^(?:\/|[A-Za-z]:\/)/u.test(entry.path) &&
          entry.path.split('/').includes(pluginName) &&
          entry.path.endsWith(`/${summary.skillName}/SKILL.md`)
            ? await resolve(entry.path)
            : { skipped: true },
      }))
    ),
  }
}
