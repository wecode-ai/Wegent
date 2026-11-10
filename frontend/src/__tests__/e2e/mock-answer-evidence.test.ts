import { resolveEvidenceResponseContent } from '../../../e2e/utils/mock-answer-evidence'

test('multi-reference model response uses unique actual request identities', () => {
  const unit = {
    evidence_id: 'first',
    content: '同名第一原文',
    document_id: 9,
    knowledge_base_id: 7,
  }
  const body = {
    messages: [
      { role: 'tool', content: JSON.stringify({ chunks: [unit] }) },
      {
        role: 'tool',
        content: JSON.stringify({
          chunks: [unit, { ...unit, evidence_id: 'second', document_id: 10 }],
        }),
      },
    ],
  }
  expect(
    resolveEvidenceResponseContent('{{answer_evidence_all}} 重复{{answer_evidence}}', body)
  ).toBe('[[evidence:first]][[evidence:second]] 重复[[evidence:first]]')
})
