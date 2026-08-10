import {
  VIDEO_TIMESTAMP_CONTRACT,
  checkVideoTimestampPrompt,
  injectVideoTimestampContract,
} from '@/features/knowledge/multimodal/utils/videoTimestampPromptGuard'

describe('videoTimestampPromptGuard', () => {
  it('treats a time-only instruction as ambiguous without a parseable chapter structure', () => {
    expect(
      checkVideoTimestampPrompt(
        '请分段输出，每个片段包含开始时间和结束时间，格式为 [HH:MM:SS - HH:MM:SS]。'
      ).status
    ).toBe('ambiguous')
  })

  it('accepts a generic parseable chapter contract', () => {
    expect(
      checkVideoTimestampPrompt(
        '请分段输出，每个片段包含开始时间和结束时间。格式：### Segment title ([HH:MM:SS - HH:MM:SS])\n> **Segment summary**: summary'
      ).status
    ).toBe('compliant')
  })

  it('treats timestamp keywords without a complete contract as ambiguous', () => {
    expect(checkVideoTimestampPrompt('请输出视频摘要，并尽量提供时间戳。').status).toBe('ambiguous')
  })

  it('detects an instruction that excludes timestamps', () => {
    expect(checkVideoTimestampPrompt('请分段总结，但不需要时间戳。').status).toBe('conflict')
  })

  it('detects a prompt unrelated to timestamps as missing', () => {
    expect(checkVideoTimestampPrompt('总结视频里的主要人物和事件。').status).toBe('missing')
  })

  it('recognizes the injected contract and injects idempotently', () => {
    const first = injectVideoTimestampContract('Summarize the video.')
    const second = injectVideoTimestampContract(first.prompt)

    expect(first.prompt).toContain(VIDEO_TIMESTAMP_CONTRACT)
    expect(checkVideoTimestampPrompt(first.prompt).status).toBe('verified')
    expect(second.prompt).toBe(first.prompt)
  })

  it('replaces a managed v1 contract with the current generic contract', () => {
    const oldPrompt = `完全分析视频

<!-- WEGENT_VIDEO_TIMESTAMP_CONTRACT:v1 -->
请按视频内容分段输出分析结果。每个片段必须包含 [HH:MM:SS - HH:MM:SS]。
<!-- /WEGENT_VIDEO_TIMESTAMP_CONTRACT:v1 -->`

    expect(checkVideoTimestampPrompt(oldPrompt).status).toBe('ambiguous')
    const result = injectVideoTimestampContract(oldPrompt)
    expect(result.prompt).toContain('WEGENT_VIDEO_TIMESTAMP_CONTRACT:v2')
    expect(result.prompt).not.toContain('WEGENT_VIDEO_TIMESTAMP_CONTRACT:v1')
    expect(result.prompt).toContain('完全分析视频')
  })

  it('reports overflow without truncating the prompt', () => {
    const original = 'a'.repeat(1990)
    const result = injectVideoTimestampContract(original)

    expect(result.exceedsLimit).toBe(true)
    expect(result.prompt).toContain(original)
  })
})
