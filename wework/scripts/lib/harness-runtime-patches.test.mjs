import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { harnessRuntimePatchSources } from './harness-runtime-patches.mjs'

const patchName = 'patches/@deepseek-ai__dsh-app-boot@0.2.0-rc.2.patch'
const sourceRoot = resolve(process.cwd(), 'harness-runtime')
const directories = []
const upstreamGetter = `/**
* Read this app-boot package's version in both source and bundled installations.
* @returns the validated runtime semantic version, preserving its exact spelling.
* @throws if package.json cannot be read or its version is missing or invalid.
*/
function getDshRuntimeVersion() {
\tconst filename = fileURLToPath(new URL("../package.json", import.meta.url));
\tconst manifest = objectOf$1(JSON.parse(fs.readFileSync(filename, "utf8")), "app-boot package.json");
\treturn runtimeVersionOf(Object.hasOwn(manifest, "version") ? manifest.version : void 0);
}
/**
* Check every @deepseek-ai/dsh or @deepseek-ai/dsh-* peer against the runtime.
* Prereleases participate in ranges. workspace:^, workspace:~, and workspace:*
*/
`

async function patchedVersionGetter(readManifest) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-runtime-patch-test-'))
  directories.push(directory)
  await mkdir(join(directory, 'lib'))
  await writeFile(join(directory, 'lib/index.js'), `${'\n'.repeat(265)}${upstreamGetter}`)
  execFileSync('git', ['apply', join(sourceRoot, patchName)], { cwd: directory })
  const patched = (await readFile(join(directory, 'lib/index.js'), 'utf8')).replace(
    'import.meta.url',
    '"file:///immutable-runtime/lib/index.js"'
  )
  const validateVersion = vi.fn(value => value)
  const getter = runInNewContext(`${patched}\ngetDshRuntimeVersion`, {
    fs: { readFileSync: readManifest },
    fileURLToPath,
    URL,
    objectOf$1: value => value,
    runtimeVersionOf: validateVersion,
  })
  return { getter, validateVersion }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
})

describe('immutable Harness runtime version patch', () => {
  test('reads and validates the exact runtime version once across repeated compatibility checks', async () => {
    const readManifest = vi.fn(() => JSON.stringify({ version: '0.2.0-rc.2' }))
    const { getter, validateVersion } = await patchedVersionGetter(readManifest)

    for (let index = 0; index < 252; index += 1) expect(getter()).toBe('0.2.0-rc.2')

    expect(readManifest).toHaveBeenCalledTimes(1)
    expect(validateVersion).toHaveBeenCalledExactlyOnceWith('0.2.0-rc.2')
    expect(readManifest).toHaveBeenCalledWith('/immutable-runtime/package.json', 'utf8')
  })

  test('propagates a failed first read and retries validation after the manifest is repaired', async () => {
    const readManifest = vi
      .fn()
      .mockReturnValueOnce('{invalid json')
      .mockReturnValue(JSON.stringify({ version: '0.2.0-rc.2' }))
    const { getter, validateVersion } = await patchedVersionGetter(readManifest)

    expect(() => getter()).toThrow()
    expect(getter()).toBe('0.2.0-rc.2')
    expect(getter()).toBe('0.2.0-rc.2')
    expect(readManifest).toHaveBeenCalledTimes(2)
    expect(validateVersion).toHaveBeenCalledTimes(1)
  })

  test('stages patch bytes and pnpm configuration as fingerprinted runtime sources', async () => {
    const manifest = JSON.parse(
      await readFile(join(sourceRoot, 'runtimes/0.2.0-rc.2/package.json'), 'utf8')
    )
    const sharedEntries = [
      { name: 'pnpm-workspace.yaml', content: Buffer.from('allowBuilds: {}\n') },
    ]
    const entries = await harnessRuntimePatchSources(sourceRoot, manifest, sharedEntries)

    expect(entries.find(entry => entry.name === patchName)?.content).toEqual(
      await readFile(join(sourceRoot, patchName))
    )
    expect(entries[0].content.toString()).toContain(
      `"@deepseek-ai/dsh-app-boot@0.2.0-rc.2": "${patchName}"`
    )
    expect(sharedEntries[0].content.toString()).toBe('allowBuilds: {}\n')
  })

  test('preserves old runtime source bytes and rejects mismatched versions or paths', async () => {
    const sharedEntries = [
      { name: 'pnpm-workspace.yaml', content: Buffer.from('allowBuilds: {}\n') },
    ]
    const oldRuntime = JSON.parse(
      await readFile(join(sourceRoot, 'runtimes/0.1.0-rc.8/package.json'), 'utf8')
    )
    expect(await harnessRuntimePatchSources(sourceRoot, oldRuntime, sharedEntries)).toBe(
      sharedEntries
    )
    await expect(
      harnessRuntimePatchSources(
        sourceRoot,
        { version: '0.1.0-rc.8', runtimePatches: { '@pkg@0.2.0-rc.2': patchName } },
        sharedEntries
      )
    ).rejects.toThrow('Invalid Harness runtime patch')
    await expect(
      harnessRuntimePatchSources(
        sourceRoot,
        { version: '0.2.0-rc.2', runtimePatches: { '@pkg@0.2.0-rc.2': '../outside.patch' } },
        sharedEntries
      )
    ).rejects.toThrow('Invalid Harness runtime patch')
  })
})
