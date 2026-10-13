import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function harnessRuntimePatchSources(sourceRoot, runtimeManifest, sharedEntries) {
  const patches = runtimeManifest.runtimePatches
  if (!patches) return sharedEntries
  const patchEntries = await Promise.all(
    Object.entries(patches).map(async ([dependency, filename]) => {
      if (
        !dependency.endsWith(`@${runtimeManifest.version}`) ||
        typeof filename !== 'string' ||
        !/^patches\/[A-Za-z0-9_@.+-]+\.patch$/.test(filename)
      ) {
        throw new Error(`Invalid Harness runtime patch: ${dependency}`)
      }
      return { name: filename, content: await readFile(join(sourceRoot, filename)) }
    })
  )
  const configuration = Object.entries(patches)
    .map(([dependency, filename]) => `  ${JSON.stringify(dependency)}: ${JSON.stringify(filename)}`)
    .join('\n')
  return [
    ...sharedEntries.map(entry =>
      entry.name === 'pnpm-workspace.yaml'
        ? {
            ...entry,
            content: Buffer.from(`${entry.content}\npatchedDependencies:\n${configuration}\n`),
          }
        : entry
    ),
    ...patchEntries,
  ]
}
