import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, normalizePath } from 'vite'
import { describe, expect, it } from 'vitest'
import { createInitialRendererChunk } from './initialRendererChunk'

describe('initial renderer chunk', () => {
  it('assigns only the main entry and leaves dependency grouping to the compiler', () => {
    const name = createInitialRendererChunk('main')
    expect(name('main')).toBe('initial-renderer')
    for (const id of ['app', 'react', 'optional-page', 'shared-icon']) {
      expect(name(id)).toBeNull()
    }
  })

  it('keeps separate build entry assignments independent', () => {
    const previous = createInitialRendererChunk('previous')
    const next = createInitialRendererChunk('next')
    expect(previous('previous')).toBe('initial-renderer')
    expect(previous('next')).toBeNull()
    expect(next('next')).toBe('initial-renderer')
    expect(next('previous')).toBeNull()
  })

  it.each([false, true])(
    'builds live static dependencies and preserves dynamic imports with shared grouping=%s',
    async groupShared => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wework-initial-chunk-')))
      const moduleId = (name: string) => normalizePath(path.join(root, name))
      const entry = moduleId('main.js')
      try {
        const files = {
          'main.js':
            'import { mainCommon } from "./barrel.js"; import { required } from "./required.js"; console.log(mainCommon, required); export const load = () => import("./dynamic.js")',
          'core.js': 'import { common } from "./barrel.js"; export { common }',
          'barrel.js':
            'export { mainCommon } from "./main-common.js"; export { common } from "./common.js"; export { optional } from "./optional.js"',
          'main-common.js': 'export const mainCommon = "main-static-value"',
          'required.js': 'export const required = "required-static-value"',
          'common.js': 'export const common = "shared-static-dynamic-value"',
          'optional.js': 'export const optional = "optional-dynamic-value"',
          'dynamic.js':
            'export const loadCommon = () => import("./common.js"); export const loadOptional = () => import("./optional.js")',
        }
        await Promise.all(
          Object.entries(files).map(([name, code]) => writeFile(path.join(root, name), code))
        )
        let checked = false
        await build({
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [
            {
              name: 'verify-initial-live-dependencies',
              generateBundle(_options, bundle) {
                const chunks = Object.values(bundle).filter(chunk => chunk.type === 'chunk')
                const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
                const initial = chunks.find(chunk => Object.keys(chunk.modules).includes(entry))!
                const core = chunks.find(chunk => chunk.facadeModuleId === moduleId('core.js'))!
                const staticChunks = new Set<string>()
                const pending = [initial.fileName, core.fileName]
                while (pending.length > 0) {
                  const name = pending.pop()!
                  if (staticChunks.has(name)) continue
                  staticChunks.add(name)
                  pending.push(...byName.get(name)!.imports)
                }
                const staticModules = new Set(
                  [...staticChunks].flatMap(name => Object.keys(byName.get(name)!.modules))
                )
                expect(Object.keys(initial.modules)).toContain(moduleId('required.js'))
                expect(staticModules.has(moduleId('common.js'))).toBe(true)
                expect(staticModules.has(moduleId('optional.js'))).toBe(false)
                expect(staticModules.has(moduleId('dynamic.js'))).toBe(false)
                const dynamic = chunks.find(chunk =>
                  Object.keys(chunk.modules).includes(moduleId('dynamic.js'))
                )!
                const dynamicModules = new Set(
                  dynamic.dynamicImports.flatMap(name => Object.keys(byName.get(name)!.modules))
                )
                expect(dynamicModules.has(moduleId('common.js'))).toBe(true)
                expect(dynamicModules.has(moduleId('optional.js'))).toBe(true)
                if (groupShared) {
                  const shared = chunks.find(chunk => chunk.name === 'shared-fixture')!
                  expect(Object.keys(shared.modules)).toContain(moduleId('common.js'))
                  expect(Object.keys(shared.modules)).not.toContain(moduleId('optional.js'))
                }
                checked = true
              },
            },
          ],
          build: {
            write: false,
            minify: false,
            rolldownOptions: {
              preserveEntrySignatures: 'strict',
              input: { main: entry, core: moduleId('core.js') },
              output: {
                codeSplitting: {
                  groups: [
                    { name: createInitialRendererChunk(entry) },
                    ...(groupShared
                      ? [
                          {
                            name: 'shared-fixture',
                            test: (id: string) =>
                              id === moduleId('common.js') || id === moduleId('optional.js'),
                            minShareCount: 2,
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
          },
        })
        expect(checked).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
