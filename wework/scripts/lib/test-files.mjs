import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export function discoverTestFiles(root, directories = ['dsh', 'scripts']) {
  return directories
    .flatMap(directory => listTestFiles(join(root, directory)))
    .map(path => relative(root, path).replaceAll('\\', '/'))
    .sort()
}

export function discoverNodeTestFiles(root, directories) {
  return discoverTestFiles(root, directories).filter(path =>
    readFileSync(join(root, path), 'utf8').includes("from 'node:test'")
  )
}

function listTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listTestFiles(path)
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [path] : []
  })
}
