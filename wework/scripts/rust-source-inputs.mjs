import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Cargo owns the dependency graph, including workspace members and external path crates.
export function rustSourceInputs(manifestPath) {
  const queue = [resolve(manifestPath)]
  const visited = new Set()
  const directories = new Set()
  const files = new Set()
  while (queue.length > 0) {
    const manifest = queue.pop()
    if (visited.has(manifest)) continue
    const metadata = JSON.parse(
      execFileSync(
        'cargo',
        ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
      )
    )
    for (const name of ['Cargo.toml', 'Cargo.lock']) {
      const file = join(metadata.workspace_root, name)
      if (existsSync(file)) files.add(file)
    }
    for (const pkg of metadata.packages) {
      const packageManifest = resolve(pkg.manifest_path)
      visited.add(packageManifest)
      files.add(packageManifest)
      const source = join(dirname(packageManifest), 'src')
      if (existsSync(source)) directories.add(source)
      const buildScript = join(dirname(packageManifest), 'build.rs')
      if (existsSync(buildScript)) files.add(buildScript)
      for (const input of pkg.metadata?.wegent?.['source-inputs'] ?? []) {
        const path = resolve(dirname(packageManifest), input)
        if (!existsSync(path)) {
          throw new Error(`Missing Rust source input ${path} declared by ${packageManifest}`)
        }
        if (statSync(path).isDirectory()) directories.add(path)
        else files.add(path)
      }
      for (const dependency of pkg.dependencies) {
        if (dependency.path) queue.push(join(dependency.path, 'Cargo.toml'))
      }
    }
  }
  return { directories: [...directories].sort(), files: [...files].sort() }
}
