import { posix } from 'node:path'

function normalizePath(value) {
  const path = value.replaceAll('\\', '/')
  return `${path.startsWith('//') ? '/' : ''}${posix.normalize(path)}`
}

export function readSkillCatalogs(body) {
  const texts = typeof body.instructions === 'string' ? [body.instructions] : []
  for (const message of body.input ?? []) {
    if (!['developer', 'system', 'user'].includes(message.role)) continue
    if (typeof message.content === 'string') texts.push(message.content)
    else {
      for (const content of message.content ?? []) {
        if (typeof content.text === 'string') texts.push(content.text)
      }
    }
  }
  return texts.flatMap(text =>
    [...text.matchAll(/<skills_instructions>([\s\S]*?)<\/skills_instructions>/gu)].map(
      match => match[1]
    )
  )
}

/** Project only the requested skill from the current catalog, never its surrounding prompt. */
export function describeTargetSkillCatalog(
  body,
  { expectedSkillName, expectedPath, parserResult }
) {
  const catalogs = readSkillCatalogs(body)
  const roots = new Map()
  const targets = []
  let section = null
  let skillCount = 0
  for (const raw of (catalogs.at(-1) ?? '').split(/\r?\n/u)) {
    const line = raw.trim()
    if (/^#{1,6} /u.test(line)) {
      section =
        line === '### Skill roots' ? 'roots' : line === '### Available skills' ? 'skills' : null
      continue
    }
    const root = section === 'roots' && line.match(/^- `([^`]+)` = `([^`]+)`$/u)
    if (root) roots.set(root[1], root[2])
    if (section !== 'skills') continue
    const entry = line.match(/^- (\S+): .* \(file: (.+)\)$/u)
    if (!entry) continue
    skillCount += 1
    const [, name, locator] = entry
    if (name !== expectedSkillName) continue
    const normalized = locator.replaceAll('\\', '/')
    const separator = normalized.indexOf('/')
    const alias = normalized.slice(0, separator)
    const rootPath = roots.get(alias) ?? null
    targets.push({
      name,
      locator,
      rootAlias: rootPath === null ? null : alias,
      rootPath,
      expandedPath: normalizePath(
        rootPath === null
          ? normalized
          : `${rootPath.replaceAll('\\', '/')}/${normalized.slice(separator + 1)}`
      ),
    })
  }
  return {
    expectedSkillName,
    expectedPath,
    parserResult,
    catalogCount: catalogs.length,
    rootCount: roots.size,
    skillCount,
    targetCount: targets.length,
    targets,
  }
}
