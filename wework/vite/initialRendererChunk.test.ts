import { describe, expect, it, vi } from 'vitest'
import { createInitialRendererChunk } from './initialRendererChunk'

describe('initial renderer chunk', () => {
  it('merges only the main entry static dependency graph, including cycles', () => {
    const modules: Record<string, { importedIds: string[]; dynamicallyImportedIds?: string[] }> = {
      main: { importedIds: ['react', 'app'], dynamicallyImportedIds: ['editor'] },
      app: { importedIds: ['react', 'provider'] },
      provider: { importedIds: ['app'] },
      react: { importedIds: [] },
      editor: { importedIds: ['react', 'editor-library'] },
      settings: { importedIds: ['react', 'settings-library'] },
    }
    const graph = { getModuleInfo: vi.fn((id: string) => modules[id] ?? null) }
    const name = createInitialRendererChunk('main')

    for (const id of ['main', 'app', 'react', 'provider']) {
      expect(name(id, graph)).toBe('initial-renderer')
    }
    for (const id of ['editor', 'editor-library', 'settings', 'settings-library']) {
      expect(name(id, graph)).toBeNull()
    }
    expect(graph.getModuleInfo).toHaveBeenCalledTimes(4)
  })

  it('recomputes the graph for a new build', () => {
    const name = createInitialRendererChunk('main')
    const graph = { getModuleInfo: () => ({ importedIds: [] }) }
    expect(name('previous', graph)).toBeNull()
    const nextGraph = {
      getModuleInfo: (id: string) => ({ importedIds: id === 'main' ? ['next'] : [] }),
    }
    expect(name('next', nextGraph)).toBe('initial-renderer')
    expect(name('previous', nextGraph)).toBeNull()
  })
})
