interface ModuleGraph {
  getModuleInfo(id: string): { importedIds: readonly string[] } | null
}

export function createInitialRendererChunk(entryId: string) {
  let getModuleInfo: ModuleGraph['getModuleInfo'] | undefined
  const initialModules = new Set<string>()

  return (id: string, context: ModuleGraph): string | null => {
    if (getModuleInfo !== context.getModuleInfo) {
      getModuleInfo = context.getModuleInfo
      initialModules.clear()
      const pending = [entryId]
      while (pending.length > 0) {
        const moduleId = pending.pop()!
        if (initialModules.has(moduleId)) continue
        initialModules.add(moduleId)
        const module = context.getModuleInfo(moduleId)
        if (module) pending.push(...module.importedIds)
      }
    }
    // Optional DSH UI entries and dynamic imports retain their own chunks.
    return initialModules.has(id) ? 'initial-renderer' : null
  }
}
