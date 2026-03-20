/**
 * TypeScript types for the evaluation exam module.
 *
 * This module implements the "Topic as Exam Container" pattern where:
 * - Topic.extra_data stores exam configuration (ExamTopicConfig)
 * - Question.content_data stores question content (ExamQuestionContent)
 * - Answer.content_data stores exam submissions (ExamAnswerContent)
 */

// ============================================================================
// Core Exam Configuration
// ============================================================================

/**
 * Exam duration configuration in minutes (three-phase exam flow)
 */
export interface ExamDuration {
  intro: number
  exam: number
  review: number
}

/**
 * Exam scoring method configuration
 */
export interface ExamScoringConfig {
  description: string
  dimensions: string[]
  bonusNote: string
}

/**
 * Upload slot configuration for file attachments
 */
export interface ExamUploadSlot {
  key: string
  label: string
  hint: string
  required?: boolean
  maxFiles: number
  accept: string
  icon: string
  showLinkInput?: boolean
  linkLabel?: string
  linkPlaceholder?: string
}

/**
 * Bonus item configuration
 */
export interface ExamBonusItem {
  title: string
  description: string
  platforms: string
  deliverables: string[]
}

/**
 * Complete exam configuration stored in Topic.extra_data
 */
export interface ExamTopicConfig {
  title: string
  year: string
  duration: ExamDuration
  rulesMarkdown: string
  scoring: ExamScoringConfig
  timeNote: string
  uploadSlots: ExamUploadSlot[]
  bonusItems: ExamBonusItem[]
}

// ============================================================================
// Question Content
// ============================================================================

/**
 * Question display configuration
 */
export interface ExamQuestionDisplay {
  icon: string
  shortDesc: string
}

/**
 * Complete question content stored in Question.content_data
 *
 * All content (background, scenarios, tasks, requirements, deliverables)
 * is merged into a single Markdown field for flexibility.
 */
export interface ExamQuestionContent {
  display: ExamQuestionDisplay
  contentMarkdown: string
}

// ============================================================================
// Legacy Types (for backward compatibility during transition)
// ============================================================================

/**
 * @deprecated Use ExamTopicConfig instead
 */
export interface ExamTopicExtraData {
  duration: ExamDuration
  instructions: string
}

/**
 * Exam attachment metadata
 */
export interface ExamAttachment {
  /** Unique file key */
  key: string
  /** Display filename */
  filename: string
  /** File size in bytes */
  size: number
  /** MIME type (optional) */
  content_type?: string
}

/**
 * Grouped attachments for exam submission
 */
export interface ExamAttachmentGroup {
  /** Main deliverable attachments */
  main: ExamAttachment[]
  /** Interaction design attachments */
  interaction: ExamAttachment[]
  /** Bonus: Agent deployment */
  bonusAgent: {
    /** Deployment link */
    link?: string
    /** Supporting files */
    files: ExamAttachment[]
  }
  /** Bonus: Multimodal attachments */
  bonusMultimodal: ExamAttachment[]
}

/**
 * Text input fields for exam answers
 * Supports multiple text input fields with real-time saving
 */
export interface ExamAnswerInputs {
  /** Supplementary notes text content */
  supplementaryNotes?: string
}

/**
 * Extended attachment group including supplementary notes as files
 */
export interface ExtendedExamAttachmentGroup extends ExamAttachmentGroup {
  /** Supplementary notes converted to file attachments */
  supplementaryNotes?: ExamAttachment[]
}

/**
 * Exam answer content stored in Answer.content_data
 *
 * Architecture:
 * - inputs: Text input fields (real-time saved, cleared after conversion)
 * - attachments: File attachments including converted text inputs
 */
export interface ExamAnswerContent {
  /** Participant's name */
  participantName: string
  /** Selected topic ID (for validation) */
  selectedTopicId: number
  /** Text input fields (supplementaryNotes, etc.) */
  inputs?: ExamAnswerInputs
  /** Grouped file attachments (includes supplementaryNotes after conversion) */
  attachments: ExtendedExamAttachmentGroup
}

/**
 * Exam phase states (three-phase exam flow)
 * - intro: Pre-exam introduction and Q&A (default 5 min)
 * - exam: Main exam answering time (default 50 min)
 * - review: Final review and submission check (default 5 min)
 * - completed: Time expired, no more submissions allowed
 */
export type ExamPhase = 'intro' | 'exam' | 'review' | 'completed'

/**
 * Exam session status from server (three-phase exam flow)
 * Contains timing information and current phase
 */
export interface ExamSessionStatus {
  /** Current phase: intro, exam, review, or completed */
  phase: 'intro' | 'exam' | 'review' | 'completed'
  /** ISO timestamp when exam started */
  started_at: string
  /** ISO timestamp when intro phase ends */
  intro_end_at: string
  /** ISO timestamp when exam phase ends */
  exam_end_at: string
  /** ISO timestamp when review phase ends */
  review_end_at: string
  /** Remaining seconds in current phase (negative when overtime) */
  remaining_seconds: number
  /** Whether current phase time has expired (remaining_seconds < 0) */
  is_overtime: boolean
  /** Selected question ID (null if not selected) */
  selected_question_id: number | null
  /** Actual exam duration in seconds (exam + review phases only, null if not started) */
  exam_duration_seconds: number | null
}

/**
 * Exam data response from server
 */
export interface ExamDataResponse {
  topic: {
    id: number
    name: string
    creator_id: number
    visibility: string
    status: string
    current_version: string
    extra_data: ExamTopicExtraData
    created_at: string
    updated_at: string
    is_active: boolean
  }
  questions: ExamQuestion[]
  userAnswer: ExamAnswer | null
  allAnswers?: Record<string, ExamAnswer>
  session: ExamSessionStatus
}

/**
 * Exam question
 */
export interface ExamQuestion {
  id: number
  topic_id: number
  title: string
  content_type: string
  content_data: Record<string, unknown>
  status: string
  current_version: string
  order_index: number
  creator_id: number
  created_at: string
  updated_at: string
  is_active: boolean
}

/**
 * Exam answer
 */
export interface ExamAnswer {
  id: number
  question_id: number
  question_version: string
  respondent_id: number
  content_type: string
  content_data: ExamAnswerContent
  submitted_at: string
  is_latest: boolean
}

/**
 * Progress step for exam navigation
 */
export interface ExamProgressStep {
  label: string
  done: boolean
}

// ============================================================================
// Default Configurations
// ============================================================================

export const DEFAULT_EXAM_DURATION: ExamDuration = {
  intro: 5,
  exam: 50,
  review: 5,
}

export const DEFAULT_UPLOAD_SLOTS: ExamUploadSlot[] = [
  {
    key: 'interaction',
    label: '交互过程记录',
    hint: '支持 PDF、图片、文本等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.html,.json',
    icon: 'pen',
  },
  {
    key: 'main',
    label: '产出报告及方案',
    hint: '支持 PDF、Word、TXT 等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.rtf,.pages',
    icon: 'file',
  },
  {
    key: 'bonusAgent',
    label: '附加题一：Agent / Skill',
    hint: '支持图片、PDF、文档等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.pptx,.ppt,.html',
    icon: 'workflow',
    showLinkInput: true,
    linkLabel: 'Agent 分享链接',
    linkPlaceholder: '粘贴可访问/可运行的 Agent 分享链接',
  },
  {
    key: 'bonusMultimodal',
    label: '附加题二：多模态交付物',
    hint: '支持 PPTX、PDF、图片、MP4 等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pptx,.ppt,.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.avi,.svg',
    icon: 'layers',
  },
]

export const DEFAULT_BONUS_ITEMS: ExamBonusItem[] = [
  {
    title: '可自动运行的 Agent / Skill',
    description:
      '基于本次考试题目，搭建一个可自动运行的 Agent / Skill，使其能够在指定频率或按需触发时，围绕题目要求自动完成完整流程。',
    platforms:
      '实现形态（不限）：Wegent、扣子、Manus、ChatGPT / Claude、Gemini 等支持 Agent、Skill 或类似能力配置的工具均可。',
    deliverables: [
      '可访问、可运行的 Agent / Skill 分享链接或可复现配置',
      '设计方案、能力配置截图或关键节点说明',
    ],
  },
  {
    title: '多模态应用',
    description:
      '将同一份分析结论/报告，用 AI 辅助转化为高质量的多模态交付物（如结构图、思维导图、流程图、PPT、短视频等）。',
    platforms:
      '实现形态（不设限）：Wegent、扣子、Manus、Gemini/ChatGPT/Claude、多模态制图/制片工具、PPT工具等均可。',
    deliverables: [
      '多模态实现方案',
      '多模态成品：PPT（建议≥5页）/结构图/信息图/短视频（建议30–90秒）',
    ],
  },
]

export const DEFAULT_SCORING: ExamScoringConfig = {
  description: '由 AI Agent 评分机器人打分，专家组复核校验，一周内出具AI考评个人报告',
  dimensions: ['提示词与任务拆解', '对话交互质量', '模型/工具选用策略', '安全意识', '结果校验检查'],
  bonusNote:
    '加分维度：Agent搭建及多模态应用，因考试时间紧张，如果不能完成Agent搭建或多模态输出，提供完整思路也可酌情加分',
}

export const DEFAULT_RULES_MARKDOWN = `## 考试规则

- **考试时间**：5分钟考前介绍答疑+50分钟答题+5分钟提交结果初查
- **工具不限**：不限制应用模型或工具，公司内外部工具、国内/海外工具均可使用
- **提交要求**：请按要求提交作答说明、AI交互过程记录及产出报告/方案
- **公平原则**：为确保公平性，现场不得直接使用过往工作产出作为结果提交
`

export const DEFAULT_TIME_NOTE =
  '在时间有限题目难度大的情况下，本次AI应用考试更多是考量在与AI工具交互过程中驾驭工具的能力，但也需要尽量保证产出结果的完成可靠性。'

// ============================================================================
// Helper Functions
// ============================================================================

export function createDefaultTopicConfig(title = 'AI应用能力考核'): ExamTopicConfig {
  return {
    title,
    year: new Date().getFullYear().toString(),
    duration: DEFAULT_EXAM_DURATION,
    rulesMarkdown: DEFAULT_RULES_MARKDOWN,
    scoring: DEFAULT_SCORING,
    timeNote: DEFAULT_TIME_NOTE,
    uploadSlots: DEFAULT_UPLOAD_SLOTS,
    bonusItems: DEFAULT_BONUS_ITEMS,
  }
}

export function createDefaultQuestionContent(): ExamQuestionContent {
  return {
    display: {
      icon: 'file',
      shortDesc: '',
    },
    contentMarkdown: `## 题目背景

请描述题目的背景信息...

## 情景选项（可选）

- 选项 A: ...
- 选项 B: ...

## 任务要求

1. **任务一**: 任务描述...
2. **任务二**: 任务描述...

> ## 文档要求
> 
> 文档要求观点清晰、逻辑自洽。
> 
> ## 交付内容
> 
> 1. 提交与 AI 的交互过程记录
> 2. 提交题目要求的正式产出报告（支持 PDF、Word等）
> 3. 请在"作答补充说明"中简要说明本次借助 AI 完成作答的整体思路。
> 
> ## 附加题交付（可选）
> 
> - 如参与"可自动运行的 Agent / Skill"，请提交可访问/可运行的 Agent 分享链接
> - 如参与"多模态应用"，请上传基于本次作答生成的多模态交付物
`,
  }
}

// ============================================================================
// Type Guards
// ============================================================================

export function isExamTopicConfig(value: unknown): value is ExamTopicConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'title' in value &&
    'year' in value &&
    'duration' in value &&
    'rulesMarkdown' in value
  )
}

export function isExamQuestionContent(value: unknown): value is ExamQuestionContent {
  return (
    typeof value === 'object' && value !== null && 'display' in value && 'contentMarkdown' in value
  )
}

// Component Props Interfaces

/**
 * Props for the main exam page component
 */
export interface ExamPageProps {
  /** Topic ID for the exam */
  topicId: number
}

/**
 * Props for the exam header component
 */
export interface ExamHeaderProps {
  /** Exam title */
  title: string
  /** Exam year/season */
  year: string
  /** Logo text to display */
  logoText: string
  /** Current exam phase */
  examPhase: ExamPhase
  /** Time left in seconds */
  timeLeft: number
  /** Progress steps for navigation */
  progressSteps: ExamProgressStep[]
}
