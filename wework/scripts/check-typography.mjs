import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const SOURCE_ROOT = new URL('../src/', import.meta.url)
const SOURCE_EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
const DISALLOWED_PATTERNS = [
  {
    description: 'arbitrary Tailwind font size',
    pattern: /text-\[[^\]]*(?:px|rem)[^\]]*\]/g,
  },
  {
    description: 'literal CSS font size',
    pattern: /(?<!-)font-size\s*:\s*(?!var\()[0-9.]+(?:px|rem)/g,
  },
  {
    description: 'literal inline font size',
    pattern: /fontSize\s*:\s*['"][0-9.]+(?:px|rem)['"]/g,
  },
  {
    description: 'literal numeric component font size',
    pattern: /fontSize\s*:\s*[0-9.]+(?=\s*[,}])/g,
  },
]

async function collectSourceFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(entry => {
      const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl)
      if (entry.isDirectory()) return collectSourceFiles(entryUrl)
      return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryUrl] : []
    })
  )
  return files.flat()
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

const violations = []
for (const fileUrl of await collectSourceFiles(SOURCE_ROOT)) {
  const source = await readFile(fileUrl, 'utf8')
  for (const { description, pattern } of DISALLOWED_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      violations.push({
        description,
        file: path.relative(process.cwd(), fileUrl.pathname),
        line: lineNumberAt(source, match.index ?? 0),
        value: match[0],
      })
    }
  }
}

if (violations.length > 0) {
  console.error('Typography policy violations:')
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} ${violation.description}: ${violation.value}`
    )
  }
  process.exitCode = 1
}
