import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const weworkDirectory = dirname(scriptDirectory)
const sourceRoots = ['src/features/harness-apps', 'dsh/ui-applications/src']
const sourceExtension = /\.(?:ts|tsx)$/
const forbiddenUsage =
  /(?:from\s+['"]@\/telemetry\/client['"]|\btrack\s*\(|\bposthog\.capture\s*\()/

export function findForbiddenTelemetryImports(files) {
  return Object.entries(files)
    .filter(
      ([path, source]) =>
        !path.endsWith('.test.ts') && !path.endsWith('.test.tsx') && forbiddenUsage.test(source)
    )
    .map(([path]) => path)
    .sort()
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.isFile() && sourceExtension.test(entry.name) ? [path] : []
    })
  )
  return files.flat()
}

async function currentSource() {
  const files = await Promise.all(sourceRoots.map(root => sourceFiles(join(weworkDirectory, root))))
  const entries = await Promise.all(
    files.flat().map(async path => [relative(weworkDirectory, path), await readFile(path, 'utf8')])
  )
  return Object.fromEntries(entries)
}

async function main() {
  const violations = findForbiddenTelemetryImports(await currentSource())
  if (violations.length === 0) return
  throw new Error(`Smart App telemetry boundary violations:\n${violations.join('\n')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
