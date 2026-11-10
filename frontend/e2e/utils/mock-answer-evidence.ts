/** Resolve generation-local evidence from the model's actual request. */
export function resolveEvidenceResponseContent(
  template: string | undefined,
  body: unknown
): string | undefined {
  if (!template || !/\{\{answer_evidence(?:_all)?\}\}/.test(template)) return template
  const ids = new Set<string>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      try {
        const envelope = value.match(/^\[tool_output [^\]\n]*\btruncated=false\]\n([\s\S]*)$/)
        collect(JSON.parse(envelope ? envelope[1] : value))
      } catch {
        // Ordinary model text is not a serialized tool result.
      }
      return
    }
    if (!value || typeof value !== 'object') return
    const row = value as Record<string, unknown>
    if (
      typeof row.evidence_id === 'string' &&
      typeof row.content === 'string' &&
      row.document_id &&
      row.knowledge_base_id
    )
      ids.add(row.evidence_id)
    for (const child of Object.values(row)) collect(child)
  }
  collect(body)
  const markers = [...ids].map(id => `[[evidence:${id}]]`)
  if (!markers.length)
    throw new Error('Actual model request contains no complete answer evidence unit')
  return template
    .replaceAll('{{answer_evidence_all}}', markers.join(''))
    .replaceAll('{{answer_evidence}}', markers[0])
}
