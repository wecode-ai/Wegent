import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { registerTypeScriptSourceResolver } from './load-typescript-source.mjs'

test('the shared TypeScript loader works without package-local tooling', async () => {
  const hook = registerTypeScriptSourceResolver([
    '../../../../packages/chat-core/src/',
    '../../../electron/src/host/',
  ])
  try {
    const chatCoreSource = new URL('../../../../packages/chat-core/src/', import.meta.url)
    const electronSource = new URL('../../../electron/src/host/', import.meta.url)
    const execution = await import(new URL('local-runtime-execution.ts', chatCoreSource))
    const model = await import(new URL('local-runtime-model.ts', chatCoreSource))
    const interfaceRuntime = await import(new URL('model-interface-runtime.ts', electronSource))

    assert.equal(typeof execution.buildLocalRuntimeExecutionRequest, 'function')
    assert.equal(typeof model.resolveLocalRuntimeModelConfig, 'function')
    assert.equal(typeof interfaceRuntime.modelInterfaceProviderId, 'function')
    assert.equal(typeof interfaceRuntime.modelInterfaceRuntimeConfig, 'function')
  } finally {
    hook.deregister()
  }
})

test('relative TypeScript imports resolve from their importing module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-typescript-source-'))
  try {
    const nested = join(root, 'nested')
    await mkdir(nested)
    await writeFile(join(root, 'dependency.ts'), "export const source = 'root'\n")
    await writeFile(join(nested, 'dependency.ts'), "export const source = 'nested'\n")
    await writeFile(
      join(nested, 'entry.ts'),
      "import { source } from './dependency'\nexport { source }\n"
    )

    const sourceURL = pathToFileURL(`${await realpath(root)}/`)
    const hook = registerTypeScriptSourceResolver([sourceURL.href])
    try {
      const entry = await import(pathToFileURL(join(nested, 'entry.ts')).href)
      assert.equal(entry.source, 'nested')
    } finally {
      hook.deregister()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
