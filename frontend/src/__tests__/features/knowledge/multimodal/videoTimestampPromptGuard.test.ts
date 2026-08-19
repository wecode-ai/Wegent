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

  it('accepts a detailed chapter template with concrete and placeholder times', () => {
    const prompt = `你是一个多模态视频分析与 RAG 档案挖掘专家。请完整观看视频，将其划分为连续的语义章节，并输出结构化 Markdown 档案。

【核心执行规则】
1. 必须从 00:00:00 分析至最后一秒，最后一个章节的结束时间等于视频实际总时长。
2. 时间轴零缝隙：章节时间必须无缝连接，格式统一为 [HH:MM:SS - HH:MM:SS]。
3. 直接输出 Markdown 正文。

## 详细时间轴与章节解析

### 章节 1：[标题] ([00:00:00] - [结束时间])
> **本段摘要**：[概括核心事件]

### 章节 2：[标题] ([开始时间] - [结束时间])
> **本段摘要**：[概括核心事件]`

    expect(checkVideoTimestampPrompt(prompt).status).toBe('compliant')
  })

  it('accepts prose range rules plus a bracketed mixed-time chapter template', () => {
    // Mirrors the shared DEFAULT_VIDEO_PROMPT structure.
    const prompt = `你是一个全能的多模态视频内容分析与档案挖掘专家。
我已将完整的长视频文件提供给你。请你从全局视角出发，将其转化为带有精确时间戳的 Markdown 档案，用于后续向量数据库检索（RAG）。

【核心要求：全时段覆盖与硬性时间约束】
1. 章节 1 的开始时间必须严格为 \`00:00:00\`，最终章节的结束时间必须严格对应视频的最后一秒。
2. 章节之间必须做到前一章结束时间 = 后一章开始时间，全程无间隙。

请严格按照以下 Markdown 模板生成：

# {{VIDEO_FILENAME}}

## 全时段连续章节解析

### 章节 1：[核心标题] ([00:00:00] - [HH:MM:SS])
> **本段摘要**：[概括核心事件]

### 章节 2：[核心标题] ([上一章结束时间] - [HH:MM:SS])
> **本段摘要**：...`

    expect(checkVideoTimestampPrompt(prompt).status).toBe('compliant')
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
