// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  BookOpen,
  Ruler,
  Languages,
  Smile,
  MessageSquare,
  FileText,
  Bug,
  Code,
  Sparkles,
  Wand2,
  type LucideIcon,
} from 'lucide-react'

export interface QuickActionDef {
  id: string
  label: string
  labelZh: string
  icon: LucideIcon
  description?: string
  descriptionZh?: string
  options?: { value: string; label: string; labelZh: string }[]
}

// Text artifact quick actions
export const TEXT_QUICK_ACTIONS: QuickActionDef[] = [
  {
    id: 'reading_level',
    label: 'Reading Level',
    labelZh: '阅读等级',
    icon: BookOpen,
    description: 'Adjust the reading level',
    descriptionZh: '调整阅读难度',
    options: [
      { value: 'elementary', label: 'Elementary', labelZh: '小学' },
      { value: 'middle_school', label: 'Middle School', labelZh: '初中' },
      { value: 'high_school', label: 'High School', labelZh: '高中' },
      { value: 'college', label: 'College', labelZh: '大学' },
      { value: 'professional', label: 'Professional', labelZh: '专业' },
    ],
  },
  {
    id: 'length',
    label: 'Length',
    labelZh: '长度',
    icon: Ruler,
    description: 'Adjust the length',
    descriptionZh: '调整内容长度',
    options: [
      { value: 'shorter', label: 'Shorter', labelZh: '更短' },
      { value: 'longer', label: 'Longer', labelZh: '更长' },
    ],
  },
  {
    id: 'translate',
    label: 'Translate',
    labelZh: '翻译',
    icon: Languages,
    description: 'Translate to another language',
    descriptionZh: '翻译到其他语言',
    options: [
      { value: 'zh', label: 'Chinese', labelZh: '中文' },
      { value: 'en', label: 'English', labelZh: '英文' },
      { value: 'ja', label: 'Japanese', labelZh: '日语' },
      { value: 'ko', label: 'Korean', labelZh: '韩语' },
      { value: 'es', label: 'Spanish', labelZh: '西班牙语' },
      { value: 'fr', label: 'French', labelZh: '法语' },
    ],
  },
  {
    id: 'add_emojis',
    label: 'Add Emojis',
    labelZh: '添加表情',
    icon: Smile,
    description: 'Add emojis to the text',
    descriptionZh: '为文本添加表情符号',
  },
  {
    id: 'improve',
    label: 'Improve',
    labelZh: '改进',
    icon: Sparkles,
    description: 'Improve the writing quality',
    descriptionZh: '提升写作质量',
  },
]

// Code artifact quick actions
export const CODE_QUICK_ACTIONS: QuickActionDef[] = [
  {
    id: 'add_comments',
    label: 'Add Comments',
    labelZh: '添加注释',
    icon: MessageSquare,
    description: 'Add comments to explain the code',
    descriptionZh: '添加代码注释说明',
  },
  {
    id: 'add_logs',
    label: 'Add Logs',
    labelZh: '添加日志',
    icon: FileText,
    description: 'Add logging statements',
    descriptionZh: '添加日志语句',
  },
  {
    id: 'fix_bugs',
    label: 'Fix Bugs',
    labelZh: '修复Bug',
    icon: Bug,
    description: 'Find and fix potential bugs',
    descriptionZh: '查找并修复潜在问题',
  },
  {
    id: 'port_language',
    label: 'Convert Language',
    labelZh: '转换语言',
    icon: Code,
    description: 'Convert to another programming language',
    descriptionZh: '转换到其他编程语言',
    options: [
      { value: 'python', label: 'Python', labelZh: 'Python' },
      { value: 'javascript', label: 'JavaScript', labelZh: 'JavaScript' },
      { value: 'typescript', label: 'TypeScript', labelZh: 'TypeScript' },
      { value: 'java', label: 'Java', labelZh: 'Java' },
      { value: 'go', label: 'Go', labelZh: 'Go' },
      { value: 'rust', label: 'Rust', labelZh: 'Rust' },
      { value: 'cpp', label: 'C++', labelZh: 'C++' },
    ],
  },
  {
    id: 'optimize',
    label: 'Optimize',
    labelZh: '优化',
    icon: Wand2,
    description: 'Optimize the code for performance',
    descriptionZh: '优化代码性能',
  },
]

// Get quick actions based on artifact type
export function getQuickActions(artifactType: 'code' | 'text'): QuickActionDef[] {
  return artifactType === 'code' ? CODE_QUICK_ACTIONS : TEXT_QUICK_ACTIONS
}

// Build prompt for quick action
export function buildQuickActionPrompt(
  actionId: string,
  optionValue?: string,
  highlightedText?: string
): string {
  const allActions = [...TEXT_QUICK_ACTIONS, ...CODE_QUICK_ACTIONS]
  const action = allActions.find(a => a.id === actionId)

  if (!action) {
    return `[canvas:${actionId}]`
  }

  let prompt = `[canvas:${actionId}]`

  if (optionValue) {
    prompt += ` ${optionValue}`
  }

  if (highlightedText) {
    prompt += `\n\nSelected text:\n${highlightedText}`
  }

  return prompt
}
