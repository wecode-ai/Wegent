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

test('model response reads a complete unit inside the real tool guard envelope', () => {
  const unit = {
    evidence_id: 'native',
    content: '完整原文',
    document_id: 9,
    knowledge_base_id: 7,
  }
  const content = `[tool_output name=native total_tokens=100 truncated=false]\n${JSON.stringify({ chunks: [unit] })}`
  expect(
    resolveEvidenceResponseContent('{{answer_evidence}}', {
      messages: [{ role: 'tool', content }],
    })
  ).toBe('[[evidence:native]]')
  expect(() =>
    resolveEvidenceResponseContent('{{answer_evidence}}', {
      messages: [{ role: 'tool', content: content.replace('truncated=false', 'truncated=true') }],
    })
  ).toThrow('no complete answer evidence unit')
})
