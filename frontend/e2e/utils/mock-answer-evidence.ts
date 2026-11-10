/** Resolve generation-local evidence from the model's actual request. */
export function resolveEvidenceResponseContent(
  template: string | undefined,
  body: unknown
): string | undefined {
  if (!template?.includes('{{answer_evidence}}')) return template
  const find = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
      try {
        return find(JSON.parse(value))
      } catch {
        return undefined
      }
    }
    if (!value || typeof value !== 'object') return undefined
    const row = value as Record<string, unknown>
    if (
      typeof row.evidence_id === 'string' &&
      typeof row.content === 'string' &&
      row.document_id &&
      row.knowledge_base_id
    )
      return row.evidence_id
    for (const child of Object.values(row)) {
      const id = find(child)
      if (id) return id
    }
    return undefined
  }
  const localId = find(body)
  if (!localId) throw new Error('Actual model request contains no complete answer evidence unit')
  return template.replaceAll('{{answer_evidence}}', `[[evidence:${localId}]]`)
}
