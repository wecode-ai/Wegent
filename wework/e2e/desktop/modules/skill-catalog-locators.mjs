import { posix } from 'node:path'

function normalizeLocator(value) {
  const path = value.replaceAll('\\', '/')
  return `${path.startsWith('//') ? '/' : ''}${posix.normalize(path)}`
}

/** Retain only catalog structure and paths, never request text or credentials. */
export function requestSkillCatalogDiagnostics(body) {
  const paths = new Set()
  const candidatePaths = new Set()
  const headings = new Set()
  let rootsSectionCount = 0
  let skillsSectionCount = 0
  function visit(value) {
    if (typeof value !== 'string') {
      if (value && typeof value === 'object') Object.values(value).forEach(visit)
      return
    }
    const roots = new Map()
    let section = null
    for (const rawLine of value.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (/^#{1,6} (?:Skill roots|Available skills)$/u.test(line)) headings.add(line)
      const candidate = line.match(/\(file: (.+)\)$/u)
      if (candidate) candidatePaths.add(candidate[1])
      if (/^#{1,6} /u.test(line) || /^<\/?skills_instructions>/u.test(line)) {
        section =
          line === '### Skill roots' ? 'roots' : line === '### Available skills' ? 'skills' : null
        if (section === 'roots') rootsSectionCount++
        if (section === 'skills') skillsSectionCount++
        if (section === 'roots' || /^#{1,2} |^<\/?skills_instructions>/u.test(line)) roots.clear()
        continue
      }
      if (section === 'roots') {
        const root = line.match(/^- `([^`]+)` = `([^`]+)`$/u)
        if (root) roots.set(root[1], root[2])
      }
      if (section !== 'skills') continue
      const entry = line.match(/^- .+ \(file: (.+)\)$/u)
      if (!entry) continue
      const locator = entry[1].replaceAll('\\', '/')
      const separator = locator.indexOf('/')
      const root = roots.get(locator.slice(0, separator))
      paths.add(normalizeLocator(root ? `${root}/${locator.slice(separator + 1)}` : locator))
    }
  }
  visit(body)
  return {
    advertisedSkillPaths: [...paths],
    catalogHeadings: [...headings],
    rootsSectionCount,
    skillsSectionCount,
    candidateLocatorCount: candidatePaths.size,
    candidateLocatorPaths: [...candidatePaths].slice(0, 50),
  }
}

export function requestContainsSkillLocator(body, skillPath) {
  return requestSkillCatalogDiagnostics(body).advertisedSkillPaths.includes(
    normalizeLocator(skillPath)
  )
}
