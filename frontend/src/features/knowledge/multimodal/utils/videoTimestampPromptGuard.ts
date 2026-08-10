// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const MAX_MULTIMODAL_PROMPT_LENGTH = 2000

export type VideoTimestampPromptStatus =
  | 'verified'
  | 'compliant'
  | 'ambiguous'
  | 'missing'
  | 'conflict'

const CONTRACT_START = '<!-- WEGENT_VIDEO_TIMESTAMP_CONTRACT:v2 -->'
const CONTRACT_END = '<!-- /WEGENT_VIDEO_TIMESTAMP_CONTRACT:v2 -->'
const MANAGED_CONTRACT_PATTERN =
  /<!-- WEGENT_VIDEO_TIMESTAMP_CONTRACT:v\d+ -->[\s\S]*?<!-- \/WEGENT_VIDEO_TIMESTAMP_CONTRACT:v\d+ -->/g

export const VIDEO_TIMESTAMP_CONTRACT = `${CONTRACT_START}
以下要求只约束输出结构，不改变或缩减用户原提示词要求分析的内容，适用于任何类型和主题的视频。

请按视频内容的自然语义分段，并将每个片段输出为一个独立的 Markdown 章节，严格使用以下结构：

### <替换为简明的本段标题> ([HH:MM:SS - HH:MM:SS])
> **本段摘要**：<替换为本时间段的核心内容摘要>
<继续输出用户原提示词要求的本段详细分析内容>

要求：
1. 必须把尖括号中的说明替换为真实内容，不得原样输出占位符。
2. 每个片段必须有独立的三级标题，不得改用列表项、纯粗体时间戳或把多个片段合并在同一章节。
3. 时间必须对应真实视频内容，开始时间小于结束时间，且不得超过视频实际时长。
4. 时间严格使用 24 小时制字段含义的 [HH:MM:SS - HH:MM:SS]：HH 是小时、MM 是分钟、SS 是秒。例如 4 分 59 秒必须写成 00:04:59，禁止写成 04:59:00。
${CONTRACT_END}`

export interface VideoTimestampPromptCheck {
  status: VideoTimestampPromptStatus
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function checkVideoTimestampPrompt(prompt: string): VideoTimestampPromptCheck {
  const normalized = normalize(prompt)
  if (!normalized) return { status: 'missing' }

  if (normalized.includes(normalize(VIDEO_TIMESTAMP_CONTRACT))) {
    return { status: 'verified' }
  }
  if (/WEGENT_VIDEO_TIMESTAMP_CONTRACT:v\d+/.test(prompt)) {
    return { status: 'ambiguous' }
  }

  const hasTimestampTerm = /(时间戳|时间码|时间范围|timestamp|timecode|time range)/i.test(prompt)
  const hasNegativeInstruction =
    /(不要|无需|不需要|禁止|忽略).{0,12}(时间戳|时间码|时间范围)|(without|omit|ignore|no)\s+(timestamps?|timecodes?|time ranges?)/i.test(
      prompt
    )
  if (hasTimestampTerm && hasNegativeInstruction) return { status: 'conflict' }

  const hasOutputInstruction = /(输出|生成|标注|包含|provide|output|include|label)/i.test(prompt)
  const hasSegmentInstruction = /(每个|逐个|分段|片段|章节|each|every|segment|chapter)/i.test(
    prompt
  )
  const hasRangeInstruction = /(开始.{0,12}结束|起始.{0,12}结束|start.{0,16}end|time range)/i.test(
    prompt
  )
  const hasExplicitFormat =
    /hh\s*:\s*mm\s*:\s*ss.{0,10}hh\s*:\s*mm\s*:\s*ss/i.test(prompt) ||
    /\[?\d{1,2}:\d{2}:\d{2}\s*[-–—~至]\s*\d{1,2}:\d{2}:\d{2}\]?/.test(prompt)
  const hasChapterStructure = /#{1,6}.{0,80}hh\s*:\s*mm\s*:\s*ss/i.test(prompt)
  const hasSummaryStructure = /(本段摘要|segment summary)/i.test(prompt)

  if (
    hasOutputInstruction &&
    hasSegmentInstruction &&
    hasRangeInstruction &&
    hasExplicitFormat &&
    hasChapterStructure &&
    hasSummaryStructure
  ) {
    return { status: 'compliant' }
  }
  if (hasTimestampTerm || hasRangeInstruction || hasExplicitFormat) {
    return { status: 'ambiguous' }
  }
  return { status: 'missing' }
}

export interface InjectVideoTimestampContractResult {
  prompt: string
  changed: boolean
  exceedsLimit: boolean
}

export function injectVideoTimestampContract(
  prompt: string,
  maxLength = MAX_MULTIMODAL_PROMPT_LENGTH
): InjectVideoTimestampContractResult {
  const base = prompt.replace(MANAGED_CONTRACT_PATTERN, '').trim()
  const nextPrompt = `${base}${base ? '\n\n' : ''}${VIDEO_TIMESTAMP_CONTRACT}`
  return {
    prompt: nextPrompt,
    changed: nextPrompt !== prompt,
    exceedsLimit: nextPrompt.length > maxLength,
  }
}
