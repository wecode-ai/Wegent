export function createInitialRendererChunk(entryId: string) {
  // Rolldown groups include the compiler's live dependencies recursively.
  return (id: string): string | null => (id === entryId ? 'initial-renderer' : null)
}
