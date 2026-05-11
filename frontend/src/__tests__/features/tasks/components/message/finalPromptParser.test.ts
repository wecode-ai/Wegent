import { parseMarkdownFinalPrompt } from '@/features/tasks/components/message/finalPromptParser'

describe('parseMarkdownFinalPrompt', () => {
  it('extracts a final prompt from a fenced final prompt section', () => {
    const result = parseMarkdownFinalPrompt(
      [
        'Intro text',
        '',
        '## ✅ 最终需求提示词',
        '```markdown',
        'Build the pipeline handoff UI',
        '```',
      ].join('\n')
    )

    expect(result).toEqual({
      type: 'final_prompt',
      final_prompt: '```markdown\nBuild the pipeline handoff UI',
    })
  })

  it('extracts a final prompt without a code fence', () => {
    const result = parseMarkdownFinalPrompt(
      ['# Final Requirement Prompt', 'Use the last AI answer as the next stage input.'].join('\n')
    )

    expect(result).toEqual({
      type: 'final_prompt',
      final_prompt: 'Use the last AI answer as the next stage input.',
    })
  })

  it('returns null when the content has no final prompt section', () => {
    expect(parseMarkdownFinalPrompt('A normal AI answer')).toBeNull()
  })
})
