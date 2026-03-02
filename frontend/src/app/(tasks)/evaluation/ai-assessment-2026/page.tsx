// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useExamTimer } from '@wecode/components/evaluation/exam/hooks/useExamTimer'
import { SlotBasedFileUpload } from '@wecode/components/evaluation/exam/SlotBasedFileUpload'
import { uploadTextAsFile } from '@wecode/api/evaluation-shared'
import {
  getExamData,
  submitExamAnswer,
  updateExamAttachments,
  selectExamQuestion,
  advanceExamPhase,
} from '@wecode/api/evaluation-exam'
import type { ExamAttachment, ExamSessionStatus } from '@wecode/types/evaluation-exam'

// Import extracted components
import {
  Icon,
  AIAssessmentTopicCard,
  AIAssessmentTopicDetail,
  ExamHeader,
  ExamInfoSection,
  BonusItemsSection,
  SupplementaryNotesSection,
  SubmitSection,
  ParticipantInfoSection,
  CompletedState,
  ConfirmModal,
  SuccessModal,
  EndExamConfirmModal,
  LeaveExamConfirmModal,
} from '@wecode/components/evaluation/exam'
import type { Topic } from '@wecode/components/evaluation/exam'

/**
 * AI Assessment 2026 Exam Page
 *
 * This page implements the AI Assessment 2026 exam interface with:
 * - Hardcoded exam data specific to the 2026 AI assessment
 * - Multi-phase exam flow (ready -> intro -> exam -> review -> completed)
 * - Topic selection with detailed requirements
 * - File upload slots for deliverables
 * - Supplementary notes with real-time sync
 * - Timer and progress tracking
 */

// ========== EXAM CONTENT DATA ==========
const EXAM_DATA = {
  title: '微博高管AI应用能力考核',
  year: '2026',
  duration: { intro: 5, exam: 50, review: 5 },
  rules: [
    { icon: 'clock', label: '考试时间', text: '5分钟考前介绍答疑+50分钟答题+5分钟提交结果初查' },
    {
      icon: 'tool',
      label: '工具不限',
      text: '不限制应用模型或工具，公司内外部工具、国内/海外工具均可使用',
    },
    {
      icon: 'upload',
      label: '提交要求',
      text: '现场由本人导出/分享可体现交互过程的记录（文本/链接），以及最终产出结果',
    },
    { icon: 'shield', label: '公平原则', text: '为确保公平性，现场不得调用过往工作产出' },
  ],
  examMethod: {
    scoring: '由 AI Agent 评分机器人打分，专家组复核校验，一周内出具AI考评个人报告',
    dimensions: [
      '提示词与任务拆解',
      '对话交互质量',
      '模型/工具选用策略',
      '安全意识',
      '结果校验检查',
    ],
    bonus:
      '加分维度：Agent搭建及多模态应用，因考试时间紧张，如果不能完成Agent搭建或多模态输出，提供完整思路也可酌情加分',
  },
  timeNote:
    '在时间有限题目难度大的情况下，本次AI应用考试更多是考量在与AI工具交互过程中驾驭工具的能力，而非对输出质量进行考量，但也需要保证产出结果的完成性。',
  topics: [
    {
      id: 1,
      title: 'AI Agent智能体提效——2026年部门效率跃升方案',
      shortDesc: '系统评估AI Agent能力，制定部门"人机协作"效率提升方案',
      icon: 'robot',
      context:
        'AI Agent 指在明确目标约束下，基于大模型进行持续感知、任务拆解与工具调用，并能够自主完成多步骤执行的软件化智能执行体 ，其价值在于以接近人的工作方式承担可规模化的知识与流程性劳动。以 AI Agent 为代表的智能体技术形态，被普遍认为是 2026 年 AI 应用从"辅助工具"走向"可执行系统"的关键方向之一。请运用AI工具完成：',
      tasks: [
        { name: '能力调研', desc: '系统评估AI Agent当前能力水平、能力边界与2026年演进趋势。' },
        {
          name: '提效方案',
          desc: '基于调研结论，结合本部门业务现状，制定2026年"人机协作"效率提升方案。侧重角色重构、流程级效率而非点状工具效率。',
        },
      ],
      requirement: '文档具备多维度分析、数据实证、来源可查、目标量化等特点。附加题要求附后。',
      deliverable: [
        '1. 提交与 AI 的交互过程记录，优先使用工具自带的导出功能，也可通过分享对话、使用浏览器导出当前对话页面为 PDF，或复制整理到文档中提交',
        '2. 提交题目要求的正式产出报告，即本次调研/分析的最终文档（支持 PDF、Word等）',
        '3. 请在"作答补充说明"对话框中简要说明本次借助 AI 完成作答的整体思路。',
      ],
      bonusDeliverable: [
        '如参与"可自动运行的 Agent/工作流"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
        '如参与"多模态应用"，请上传基于本次作答生成的多模态交付物，如 PPT、结构图、信息图、短视频等',
        '附加题材料用于加分评审，均为可选填。',
      ],
    },
    {
      id: 2,
      title: '出海破局与投资决策 —— 2026 年海外市场拓展可行性方案',
      shortDesc: '以海外投资负责人视角，完成海外市场投资可行性报告',
      icon: 'globe',
      context:
        '海外市场被认为是 2026 年中国互联网公司的关键增量来源之一。请您以某互联网平台海外投资负责人的角色，任选以下两个情形或者自己设定一个类似情形，运用 AI 工具，完成海外市场投资的可行性报告：',
      scenarios: [
        'A. 中国社交媒体平台（类似微博）进入沙特阿拉伯市场，利用政府、本土化等优势与 X / Facebook 等全球平台竞争。',
        'B. 中国生活服务平台（类似美团）进入东南亚如泰国市场，复制中国市场的成功模式。',
      ],
      tasksLabel: '可行性报告内容参考：',
      tasks: [
        {
          name: '市场与模式判断',
          desc: '系统评估目标海外市场在2026 年前后的发展潜力与进入可行性，包括但不限于市场环境调研、竞争与替代分析、进入市场筛选与论证。',
        },
        {
          name: '发展预研',
          desc: '基于上述调研结论，对目标市场2026 年全年业务发展进行量化预演，比如核心业务指标预测、关键假设与推演逻辑。',
        },
        {
          name: '一年期路线图',
          desc: '基于目标市场与预测结果，制定 2026年一年期进入与推进方案，比如市场进入策略、关键里程碑、主要风险与应对预案。',
        },
      ],
      requirement: '文档要求数据驱动、来源可查、预测可推演（逻辑 > 数字本身）。附加题要求附后。',
      deliverable: [
        '1. 提交与 AI 的交互过程记录，优先使用工具自带的导出功能，也可通过分享对话、使用浏览器导出当前对话页面为 PDF，或复制整理到文档中提交',
        '2. 提交题目要求的正式产出报告，即本次调研/分析的最终文档（支持 PDF、Word等）',
        '3. 请在"作答补充说明"对话框中简要说明本次借助 AI 完成作答的整体思路。',
      ],
      bonusDeliverable: [
        '如参与"可自动运行的 Agent/工作流"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
        '如参与"多模态应用"，请上传基于本次作答生成的多模态交付物，如 PPT、结构图、信息图、短视频等',
        '附加题材料用于加分评审，均为可选填。',
      ],
    },
    {
      id: 3,
      title: 'AI 智能软硬件演进下的社交媒体形态变化（2026 视角）',
      shortDesc: '分析AI发展对社交媒体的影响，提出平台应对策略',
      icon: 'sparkle',
      context:
        '随着 AI 大模型、生成式内容能力及智能硬件（如 AI 眼镜、可穿戴设备、车载终端等）的快速发展，内容生产、内容消费与用户终端形态正在发生系统性变化。\n社交媒体不再仅以"手机 + 信息流 + 原文/视频"为核心形态，2026 年前后可能出现新的产品形态与竞争格局。',
      contextSuffix:
        '请你站在 社交媒体平台负责人 / 战略负责人 的视角，运用 AI 工具，对 AI 智能软硬件发展背景下的社交媒体演进方向进行分析，并提出应对方案。比如：',
      tasks: [
        {
          name: '趋势研判',
          desc: '系统分析 AI 发展对社交媒体的关键影响，包括但不限于内容生产侧变化，内容消费侧变化，终端与场景变化。',
        },
        {
          name: '形态预演',
          desc: '基于趋势分析，对 2026 年社交媒体可能出现的 1–2 种核心新形态进行预演，新形态的核心特征与当前主流社交媒体形态的关键差异对用户使用频率、内容生态和商业模式的潜在影响。',
        },
        {
          name: '平台应对策略',
          desc: '结合对形态变化的判断，提出平台在未来一年内的应对策略，比如：战略选择、关键验证动作、主要风险与不确定性。',
        },
      ],
      requirement: '文档要求观点清晰、逻辑自洽。附加题要求附后。',
      deliverable: [
        '1. 提交与 AI 的交互过程记录，优先使用工具自带的导出功能，也可通过分享对话、使用浏览器导出当前对话页面为 PDF，或复制整理到文档中提交',
        '2. 提交题目要求的正式产出报告，即本次调研/分析的最终文档（支持 PDF、Word等）',
        '3. 请在"作答补充说明"对话框中简要说明本次借助 AI 完成作答的整体思路。',
      ],
      bonusDeliverable: [
        '如参与"可自动运行的 Agent/工作流"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
        '如参与"多模态应用"，请上传基于本次作答生成的多模态交付物，如 PPT、结构图、信息图、短视频等',
        '附加题材料用于加分评审，均为可选填。',
      ],
    },
  ] as Topic[],
  bonusItems: [
    {
      id: 1,
      title: '可自动运行的 Agent/工作流',
      description:
        '让系统能在指定频率（如每周/每月/每次触发）根据上述议题自动完成"信息获取→结构化处理→按既定输出模板生成草稿→标注来源与不确定点"的闭环。输出模板随题目不同而不同，但闭环能力一致。',
      platforms:
        '实现形态（不设限）：Wegent、扣子、Manus、ChatGPT/Claude 工作流、脚本+定时任务均可。',
      deliverables: [
        '可访问/可运行的 Agent 分享链接或可复现配置（评审可触发运行）',
        '设计方案、工作流图或节点配置截图（能看出输入、步骤、输出）',
      ],
    },
    {
      id: 2,
      title: '多模态应用',
      description:
        '参评人能将同一份分析结论/报告，用 AI 辅助转化为高质量的多模态交付物（如结构图、思维导图、流程图、对比图、信息图、PPT、短视频/讲解稿+画面脚本等），用于提升"可读性、说服力、传播效率与对齐效率"。',
      platforms:
        '实现形态（不设限）：Wegent、扣子、Manus、Gemini/ChatGPT/Claude、多模态制图/制片工具、PPT工具、在线白板/脑图工具、脚本+渲染等均可。',
      deliverables: [
        '多模态实现方案',
        '多模态成品：PPT（建议≥5页）/结构图或思维导图（可读清晰）/信息图或对比图（可用于汇报）/短视频（建议30–90秒，含字幕或解说稿）',
      ],
    },
  ],
}

// ========== UPLOAD SLOTS ==========
const UPLOAD_SLOTS = [
  {
    key: 'interaction',
    label: '交互过程记录',
    hint: '支持 PDF、图片、文本等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.html,.json',
    icon: <Icon name="pen" size={18} className="text-gray-400" />,
  },
  {
    key: 'main',
    label: '产出报告及方案',
    hint: '支持 PDF、Word、TXT 等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.rtf,.pages',
    icon: <Icon name="file" size={18} className="text-[#DF2029]" />,
  },
  {
    key: 'bonusAgent',
    label: '附加题一：Agent / 工作流',
    hint: '支持图片、PDF、文档等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.pptx,.ppt,.html',
    icon: <Icon name="workflow" size={18} className="text-indigo-500" />,
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
    icon: <Icon name="layers" size={18} className="text-rose-500" />,
  },
]

export default function AIAssessment2026Page() {
  const router = useRouter()
  const { user, isLoading: isUserLoading } = useUser()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const [examSession, setExamSession] = useState<ExamSessionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedTopic, setSelectedTopic] = useState<number | null>(null)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const dataLoadedRef = useRef(false)
  const participantName = user?.user_name || ''

  // Use exam timer hook for accurate timing based on server timestamps
  // Only shows timer during exam phase, no automatic phase transitions
  const {
    phase: examPhase,
    remainingSeconds: timeLeft,
    isCompleted,
    submitCount,
    isOvertime,
    showTimer,
  } = useExamTimer({
    session: examSession,
  })

  // Track last saved time for each question
  const [lastSavedMap, setLastSavedMap] = useState<Record<number, Date | null>>({
    1: null,
    2: null,
    3: null,
  })

  // Per-question state
  const [questionData, setQuestionData] = useState<
    Record<
      number,
      {
        attachments: Record<string, ExamAttachment[]>
        supplementaryNotes: string
        supplementaryNotesFiles: ExamAttachment[]
        linkValues: Record<string, string>
      }
    >
  >({
    1: {
      attachments: { main: [], interaction: [], bonusAgent: [], bonusMultimodal: [] },
      supplementaryNotes: '',
      supplementaryNotesFiles: [],
      linkValues: { bonusAgent: '' },
    },
    2: {
      attachments: { main: [], interaction: [], bonusAgent: [], bonusMultimodal: [] },
      supplementaryNotes: '',
      supplementaryNotesFiles: [],
      linkValues: { bonusAgent: '' },
    },
    3: {
      attachments: { main: [], interaction: [], bonusAgent: [], bonusMultimodal: [] },
      supplementaryNotes: '',
      supplementaryNotesFiles: [],
      linkValues: { bonusAgent: '' },
    },
  })

  // Modal states
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [showEndExamConfirm, setShowEndExamConfirm] = useState(false)
  const [showLeaveExamConfirm, setShowLeaveExamConfirm] = useState(false)

  // Check login status after user data is loaded
  useEffect(() => {
    // Wait for user data to finish loading before checking
    if (isUserLoading) return

    if (!user) {
      toast({
        title: t('errors.login_required'),
        description: t('errors.please_login'),
        variant: 'destructive',
      })
      router.push('/login')
    }
  }, [user, isUserLoading, router, toast, t])

  // Load exam data on mount
  useEffect(() => {
    async function loadExamData() {
      try {
        const data = await getExamData(1)
        setExamSession(data.session)
        if (data.session?.selected_question_id) {
          setSelectedTopic(data.session.selected_question_id - 1)
        }
      } catch (error: unknown) {
        console.error('Failed to load exam data:', error)
        // Handle permission denied (403)
        const err = error as { status?: number; message?: string }
        if (err?.status === 403 || err?.message?.includes('permission')) {
          toast({
            title: t('errors.load_failed'),
            description: t('errors.permission_denied'),
            variant: 'destructive',
          })
          router.push('/chat')
        }
      } finally {
        setLoading(false)
      }
    }
    if (user && !isUserLoading) {
      loadExamData()
    }
  }, [user, isUserLoading, router, toast, t])

  // Sync with server when page becomes visible after being hidden
  // This ensures accurate timing when user switches back from another tab
  usePageVisibility({
    onVisible: () => {
      // Re-fetch exam data to sync with server time
      getExamData(1)
        .then(data => {
          setExamSession(data.session)
        })
        .catch(e => {
          console.error('Failed to sync exam session on visibility change:', e)
        })
    },
    minHiddenTime: 1000, // Sync even for short tab switches (1 second)
  })

  // Fix sticky header by overriding body overflow
  useEffect(() => {
    const originalBodyOverflow = document.body.style.overflow
    const originalBodyOverflowX = document.body.style.overflowX
    const originalHtmlOverflow = document.documentElement.style.overflow
    const originalHtmlOverflowX = document.documentElement.style.overflowX

    document.body.style.overflow = 'visible'
    document.body.style.overflowX = 'visible'
    document.documentElement.style.overflow = 'visible'
    document.documentElement.style.overflowX = 'visible'

    return () => {
      document.body.style.overflow = originalBodyOverflow
      document.body.style.overflowX = originalBodyOverflowX
      document.documentElement.style.overflow = originalHtmlOverflow
      document.documentElement.style.overflowX = originalHtmlOverflowX
    }
  }, [])

  // Load existing answer data
  useEffect(() => {
    async function loadExistingAnswer() {
      if (dataLoadedRef.current || !examSession) return
      dataLoadedRef.current = true

      try {
        const data = await getExamData(1)
        if (data.userAnswer?.content_data) {
          const content = data.userAnswer.content_data
          const questionId = content.selectedTopicId

          if (questionId) {
            setQuestionData(prev => ({
              ...prev,
              [questionId]: {
                attachments: {
                  main: content.attachments?.main || [],
                  interaction: content.attachments?.interaction || [],
                  bonusAgent: content.attachments?.bonusAgent?.files || [],
                  bonusMultimodal: content.attachments?.bonusMultimodal || [],
                },
                supplementaryNotesFiles: content.supplementaryNotesFiles || [],
                supplementaryNotes:
                  (content.supplementaryNotesFiles?.length ?? 0) > 0
                    ? ''
                    : content.supplementaryNotes || '',
                linkValues: {
                  bonusAgent: content.attachments?.bonusAgent?.link || '',
                },
              },
            }))
          }
        }
      } catch (error) {
        console.error('Failed to load existing answer:', error)
        dataLoadedRef.current = false
      }
    }
    loadExistingAnswer()
  }, [examSession])

  // Computed values
  const progressSteps = useMemo(() => {
    const anyQuestionSelected = selectedTopic !== null
    // Upload materials and notes status depend on the CURRENTLY SELECTED question
    // If no question is selected, these should be false (not done)
    const currentQuestionId = selectedTopic !== null ? selectedTopic + 1 : null
    const currentData = currentQuestionId !== null ? questionData[currentQuestionId] : null

    // Required uploads: interaction record AND main report must both be present
    const hasRequiredFiles = currentData
      ? currentData.attachments.interaction.length > 0 && currentData.attachments.main.length > 0
      : false

    // Notes: either text notes or uploaded files
    const hasNotes = currentData
      ? currentData.supplementaryNotes.trim().length > 0 ||
        (currentData.supplementaryNotesFiles?.length ?? 0) > 0
      : false

    return [
      { label: '选择题目', done: anyQuestionSelected },
      { label: '上传材料', done: anyQuestionSelected && hasRequiredFiles },
      { label: '填写说明', done: anyQuestionSelected && hasNotes },
      { label: '确认提交', done: submitCount > 0 },
    ]
  }, [selectedTopic, questionData, submitCount])

  // Timer styling: red when overtime, otherwise based on remaining time
  const timerColor = useMemo(() => {
    if (isOvertime) return 'text-red-600 bg-red-50 border-red-200'
    if (timeLeft > 15 * 60) return 'text-emerald-600 bg-emerald-50 border-emerald-200'
    if (timeLeft > 5 * 60) return 'text-yellow-600 bg-yellow-50 border-yellow-200'
    return 'text-red-600 bg-red-50 border-red-200'
  }, [timeLeft, isOvertime])

  const currentQuestionData = selectedTopic !== null ? questionData[selectedTopic + 1] : null
  const hasMainReport = (currentQuestionData?.attachments.main.length ?? 0) > 0
  const hasInteractionRecord = (currentQuestionData?.attachments.interaction.length ?? 0) > 0
  const hasSupplementaryNotes =
    (currentQuestionData?.supplementaryNotes.trim().length ?? 0) > 0 ||
    (currentQuestionData?.supplementaryNotesFiles?.length ?? 0) > 0

  const isSubmitReady =
    selectedTopic !== null &&
    hasMainReport &&
    hasInteractionRecord &&
    hasSupplementaryNotes &&
    participantName.trim().length > 0 &&
    !isCompleted

  const getTotalFileCount = (questionId: number) => {
    const data = questionData[questionId]
    if (!data) return 0
    const slotFiles = Object.values(data.attachments).reduce((sum, arr) => sum + arr.length, 0)
    const supplementaryFiles = data.supplementaryNotesFiles?.length || 0
    return slotFiles + supplementaryFiles
  }

  // Handlers
  const startAnswering = async () => {
    if (isTransitioning) return
    setIsTransitioning(true)

    try {
      if (examPhase === 'ready') {
        const data = await getExamData(1, true)
        setExamSession(data.session)
        if (data.session?.selected_question_id) {
          setSelectedTopic(data.session.selected_question_id - 1)
        }
      } else if (examPhase === 'intro') {
        const result = await advanceExamPhase(1, 'exam')
        setExamSession(result.session)
      }
    } catch (error) {
      console.error('Failed to start/enter exam:', error)
      try {
        const data = await getExamData(1)
        setExamSession(data.session)
      } catch (e) {
        console.error('Failed to refresh session:', e)
      }
    } finally {
      setIsTransitioning(false)
    }
  }

  const endAnswering = () => setShowEndExamConfirm(true)

  const confirmEndAnswering = async () => {
    setShowEndExamConfirm(false)
    setIsTransitioning(true)
    try {
      const result = await advanceExamPhase(1, 'review')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to end answering:', error)
      try {
        const data = await getExamData(1)
        setExamSession(data.session)
      } catch (e) {
        console.error('Failed to refresh session:', e)
      }
    } finally {
      setIsTransitioning(false)
    }
  }

  const finishExam = () => setShowLeaveExamConfirm(true)

  const confirmFinishExam = async () => {
    setShowLeaveExamConfirm(false)
    setIsTransitioning(true)
    try {
      const result = await advanceExamPhase(1, 'completed')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to finish exam:', error)
      try {
        const data = await getExamData(1)
        setExamSession(data.session)
      } catch (e) {
        console.error('Failed to refresh session:', e)
      }
    } finally {
      setIsTransitioning(false)
    }
  }

  // Save draft for current question (without creating grading task)
  const saveDraft = async (): Promise<void> => {
    if (selectedTopic === null) return

    const currentData = questionData[selectedTopic + 1]
    if (!currentData) return

    const questionId = selectedTopic + 1

    try {
      // If there are supplementary notes text, convert to file first
      let updatedSupplementaryNotesFiles = currentData.supplementaryNotesFiles || []
      let notesToSave = currentData.supplementaryNotes

      if (notesToSave.trim()) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const randomStr = Math.random().toString(36).substring(2, 6)
        const filename = `补充说明_${timestamp}_${randomStr}.txt`

        const textResponse = await uploadTextAsFile(
          notesToSave,
          filename,
          'exam_attachment',
          1,
          questionId,
          'supplementaryNotes'
        )
        updatedSupplementaryNotesFiles = [
          ...updatedSupplementaryNotesFiles,
          {
            key: textResponse.key,
            filename: textResponse.filename,
            size: textResponse.file_size,
            content_type: textResponse.content_type,
          },
        ]
        // Clear the text area after converting to file
        setQuestionData(prev => ({
          ...prev,
          [questionId]: {
            ...prev[questionId],
            supplementaryNotesFiles: updatedSupplementaryNotesFiles,
            supplementaryNotes: '',
          },
        }))
        notesToSave = ''
      }

      // Call updateExamAttachments to create/update answer record
      await updateExamAttachments(1, {
        selectedQuestionId: questionId,
        content_data: {
          attachments: {
            main: currentData?.attachments?.main || [],
            interaction: currentData?.attachments?.interaction || [],
            bonusAgent: {
              link: currentData?.linkValues?.bonusAgent || '',
              files: currentData?.attachments?.bonusAgent || [],
            },
            bonusMultimodal: currentData?.attachments?.bonusMultimodal || [],
          },
          supplementaryNotesFiles: updatedSupplementaryNotesFiles,
          // Include the text notes if not yet converted to file
          supplementaryNotes: notesToSave,
        },
      })

      // Update last saved time
      setLastSavedMap(prev => ({
        ...prev,
        [questionId]: new Date(),
      }))
    } catch (error) {
      console.error('Failed to save draft:', error)
      throw error
    }
  }

  const saveCurrentQuestionData = async () => {
    if (selectedTopic === null) return

    const currentData = questionData[selectedTopic + 1]
    if (!currentData) return

    let updatedSupplementaryNotesFiles = currentData.supplementaryNotesFiles || []

    if (currentData.supplementaryNotes.trim()) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const randomStr = Math.random().toString(36).substring(2, 6)
        const filename = `补充说明_${timestamp}_${randomStr}.txt`

        const textResponse = await uploadTextAsFile(
          currentData.supplementaryNotes,
          filename,
          'exam_attachment',
          1,
          selectedTopic + 1,
          'supplementaryNotes'
        )
        updatedSupplementaryNotesFiles = [
          ...updatedSupplementaryNotesFiles,
          {
            key: textResponse.key,
            filename: textResponse.filename,
            size: textResponse.file_size,
            content_type: textResponse.content_type,
          },
        ]
        setQuestionData(prev => ({
          ...prev,
          [selectedTopic + 1]: {
            ...prev[selectedTopic + 1],
            supplementaryNotesFiles: updatedSupplementaryNotesFiles,
            supplementaryNotes: '',
          },
        }))
      } catch (error) {
        console.error('Failed to save supplementary notes:', error)
      }
    }

    try {
      await updateExamAttachments(1, {
        selectedQuestionId: selectedTopic + 1,
        content_data: {
          attachments: {
            main: currentData?.attachments?.main || [],
            interaction: currentData?.attachments?.interaction || [],
            bonusAgent: {
              link: currentData?.linkValues?.bonusAgent || '',
              files: currentData?.attachments?.bonusAgent || [],
            },
            bonusMultimodal: currentData?.attachments?.bonusMultimodal || [],
          },
          supplementaryNotesFiles: updatedSupplementaryNotesFiles,
        },
      })
    } catch (error) {
      console.error('Failed to sync supplementary notes files:', error)
    }
  }

  const handleTopicSelect = async (topicIndex: number | null) => {
    await saveCurrentQuestionData()
    setSelectedTopic(topicIndex)

    if (topicIndex !== null) {
      try {
        await selectExamQuestion(1, topicIndex + 1)
      } catch (error) {
        console.error('Failed to select question:', error)
      }
    }
  }

  const confirmSubmit = async () => {
    setShowConfirmModal(false)
    if (selectedTopic === null) return

    const currentData = questionData[selectedTopic + 1]

    try {
      let _supplementaryNotesFiles: ExamAttachment[] = []
      if (currentData.supplementaryNotes.trim()) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const randomStr = Math.random().toString(36).substring(2, 6)
        const filename = `补充说明_${timestamp}_${randomStr}.txt`

        const textResponse = await uploadTextAsFile(
          currentData.supplementaryNotes,
          filename,
          'exam_attachment',
          1,
          selectedTopic + 1,
          'supplementaryNotes'
        )
        _supplementaryNotesFiles = [
          ...(currentData.supplementaryNotesFiles || []),
          {
            key: textResponse.key,
            filename: textResponse.filename,
            size: textResponse.file_size,
            content_type: textResponse.content_type,
          },
        ]
      }

      const result = await submitExamAnswer(1, {
        selectedQuestionId: selectedTopic + 1,
        participantName,
        content_data: {
          examMode: true,
          participantName,
          selectedTopicId: selectedTopic + 1,
          supplementaryNotes: currentData.supplementaryNotes,
          supplementaryNotesFiles:
            _supplementaryNotesFiles.length > 0
              ? _supplementaryNotesFiles
              : currentData.supplementaryNotesFiles,
          attachments: {
            main: currentData.attachments.main,
            interaction: currentData.attachments.interaction,
            bonusAgent: {
              link: currentData.linkValues?.bonusAgent || '',
              files: currentData.attachments.bonusAgent,
            },
            bonusMultimodal: currentData.attachments.bonusMultimodal,
          },
        },
      })

      const newSubmitCount = (result as unknown as { submit_count?: number }).submit_count || 0
      setExamSession(prev => (prev ? { ...prev, submit_count: newSubmitCount } : null))

      if (_supplementaryNotesFiles.length > 0) {
        setQuestionData(prev => ({
          ...prev,
          [selectedTopic + 1]: {
            ...prev[selectedTopic + 1],
            supplementaryNotesFiles: _supplementaryNotesFiles,
            supplementaryNotes: '',
          },
        }))
      }

      setShowSuccessModal(true)
    } catch (_error) {
      // Error handled by API
    }
  }

  const handleSupplementaryFileRemove = async (index: number) => {
    if (selectedTopic === null) return

    const currentData = questionData[selectedTopic + 1]
    const fileToRemove = currentData?.supplementaryNotesFiles?.[index]
    if (!fileToRemove) return

    const newFiles = currentData.supplementaryNotesFiles.filter((_, i) => i !== index)

    setQuestionData(prev => ({
      ...prev,
      [selectedTopic + 1]: {
        ...prev[selectedTopic + 1],
        supplementaryNotesFiles: newFiles,
      },
    }))

    try {
      await updateExamAttachments(1, {
        selectedQuestionId: selectedTopic + 1,
        content_data: {
          attachments: {
            main: currentData?.attachments?.main || [],
            interaction: currentData?.attachments?.interaction || [],
            bonusAgent: {
              link: currentData?.linkValues?.bonusAgent || '',
              files: currentData?.attachments?.bonusAgent || [],
            },
            bonusMultimodal: currentData?.attachments?.bonusMultimodal || [],
          },
          supplementaryNotesFiles: newFiles,
        },
      })
    } catch (error) {
      console.error('Failed to delete supplementary file:', error)
    }
  }

  // Show loading state while checking auth
  if (isUserLoading || !user) {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-text-secondary">{t('exam.loading')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#fafbfc] overflow-visible">
      {/* Header */}
      <ExamHeader
        title={EXAM_DATA.title}
        year={EXAM_DATA.year}
        progressSteps={progressSteps}
        timeLeft={timeLeft}
        timerColor={timerColor}
        showTimer={showTimer}
        isOvertime={isOvertime}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-10">
        {/* Exam Info */}
        <ExamInfoSection
          title={`微博高层管理人员 AI 应用能力考核`}
          year={EXAM_DATA.year}
          rules={EXAM_DATA.rules}
          examMethod={EXAM_DATA.examMethod}
          timeNote={EXAM_DATA.timeNote}
          examPhase={examPhase}
          loading={loading}
          isTransitioning={isTransitioning}
          onStartAnswering={startAnswering}
        />

        {/* Participant Info */}
        {(examPhase === 'exam' || examPhase === 'review') && (
          <ParticipantInfoSection participantName={participantName} />
        )}

        {/* Topic Selection */}
        {(examPhase === 'exam' || examPhase === 'review') && (
          <section className="animate-[fadeIn_0.3s_ease-out]">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1.5 h-7 bg-[#DF2029] rounded-full" />
              <h2 className="text-xl font-bold text-gray-900">
                {examPhase === 'review' ? '已选考核题目' : '选择考核题目'}
              </h2>
              {examPhase !== 'review' && (
                <span className="text-[1rem] text-gray-400 ml-1">
                  （考题三选一，如果多选，每个维度评分取多道题的高分）
                </span>
              )}
            </div>
            {examPhase === 'review' && selectedTopic !== null ? (
              <div className="mb-6">
                <AIAssessmentTopicCard
                  topic={EXAM_DATA.topics[selectedTopic]}
                  selected={true}
                  disabled={true}
                  onClick={() => {}}
                />
                <div className="mt-6">
                  <AIAssessmentTopicDetail topic={EXAM_DATA.topics[selectedTopic]} />
                </div>
              </div>
            ) : examPhase === 'review' ? (
              <div className="text-gray-500 py-4">未选择题目</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
                  {EXAM_DATA.topics.map((topic, i) => (
                    <AIAssessmentTopicCard
                      key={topic.id}
                      topic={topic}
                      selected={selectedTopic === i}
                      disabled={isCompleted && selectedTopic !== i}
                      onClick={() =>
                        !isCompleted && handleTopicSelect(selectedTopic === i ? null : i)
                      }
                    />
                  ))}
                </div>
                {selectedTopic !== null && (
                  <AIAssessmentTopicDetail topic={EXAM_DATA.topics[selectedTopic]} />
                )}
              </>
            )}
          </section>
        )}

        {/* Bonus Items */}
        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <BonusItemsSection bonusItems={EXAM_DATA.bonusItems} />
        )}

        {/* File Uploads */}
        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <SlotBasedFileUpload
            topicId={1}
            questionId={selectedTopic + 1}
            slots={UPLOAD_SLOTS}
            attachments={questionData[selectedTopic + 1]?.attachments || {}}
            onChange={(slot: string, newAttachments: ExamAttachment[]) => {
              setQuestionData(prev => ({
                ...prev,
                [selectedTopic + 1]: {
                  ...prev[selectedTopic + 1],
                  attachments: {
                    ...prev[selectedTopic + 1].attachments,
                    [slot]: newAttachments,
                  },
                },
              }))
            }}
            onAttachmentsUpdate={async newAttachments => {
              try {
                await updateExamAttachments(1, {
                  selectedQuestionId: selectedTopic + 1,
                  content_data: {
                    attachments: {
                      main: newAttachments.main || [],
                      interaction: newAttachments.interaction || [],
                      bonusAgent: { files: newAttachments.bonusAgent || [] },
                      bonusMultimodal: newAttachments.bonusMultimodal || [],
                    },
                  },
                })
              } catch (error) {
                console.error('Failed to update attachments:', error)
              }
            }}
            linkValues={questionData[selectedTopic + 1]?.linkValues || {}}
            onLinkChange={async (slot: string, value: string) => {
              setQuestionData(prev => ({
                ...prev,
                [selectedTopic + 1]: {
                  ...prev[selectedTopic + 1],
                  linkValues: {
                    ...prev[selectedTopic + 1].linkValues,
                    [slot]: value,
                  },
                },
              }))

              try {
                const currentData = questionData[selectedTopic + 1]
                await updateExamAttachments(1, {
                  selectedQuestionId: selectedTopic + 1,
                  content_data: {
                    attachments: {
                      main: currentData?.attachments?.main || [],
                      interaction: currentData?.attachments?.interaction || [],
                      bonusAgent: {
                        link:
                          slot === 'bonusAgent' ? value : currentData?.linkValues?.bonusAgent || '',
                        files: currentData?.attachments?.bonusAgent || [],
                      },
                      bonusMultimodal: currentData?.attachments?.bonusMultimodal || [],
                    },
                  },
                })
              } catch (error) {
                console.error('Failed to update link:', error)
              }
            }}
            disabled={examPhase !== 'exam'}
            totalFileLimit={20}
            currentTotalCount={
              questionData[selectedTopic + 1]?.supplementaryNotesFiles?.length || 0
            }
            onLimitExceeded={() => {
              alert('每道题目总附件数（包括补充说明文件）不能超过 20 个，请先删除一些附件')
            }}
          />
        )}
        {/* Supplementary Notes */}
        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <SupplementaryNotesSection
            notes={questionData[selectedTopic + 1]?.supplementaryNotes || ''}
            files={questionData[selectedTopic + 1]?.supplementaryNotesFiles || []}
            disabled={examPhase !== 'exam'}
            required={true}
            onNotesChange={notes =>
              setQuestionData(prev => ({
                ...prev,
                [selectedTopic + 1]: {
                  ...prev[selectedTopic + 1],
                  supplementaryNotes: notes,
                },
              }))
            }
            onFileRemove={handleSupplementaryFileRemove}
            onSaveDraft={saveDraft}
            lastSavedAt={selectedTopic !== null ? lastSavedMap[selectedTopic + 1] : null}
          />
        )}

        {/* Submit Section */}
        {(examPhase === 'exam' || examPhase === 'review') &&
          selectedTopic !== null &&
          !isCompleted && (
            <SubmitSection
              checkItems={[
                { label: '已上传报告', done: hasMainReport, required: true },
                { label: '已上传交互记录', done: hasInteractionRecord, required: true },
                { label: '已填写说明', done: hasSupplementaryNotes, required: true },
              ]}
              submitCount={submitCount}
              totalFileCount={getTotalFileCount(selectedTopic + 1)}
              isSubmitReady={isSubmitReady}
              submitButtonText={
                submitCount > 0 ? `再次提交 (第${submitCount + 1}次)` : '提交考核材料'
              }
              onSubmit={() => setShowConfirmModal(true)}
            />
          )}

        {/* End Exam Button */}
        {examPhase === 'exam' && submitCount > 0 && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <div className="flex flex-col items-center gap-4">
                <p className="text-sm text-gray-500">完成答题后可以提前结束进入检查阶段</p>
                <button
                  onClick={endAnswering}
                  disabled={isTransitioning}
                  className={`px-10 py-3.5 bg-orange-500 hover:bg-orange-600 text-white text-lg font-bold rounded-2xl shadow-lg shadow-orange-200/50 transition-all hover:shadow-orange-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '结束答题'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Leave Exam Button */}
        {examPhase === 'review' && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <div className="flex flex-col items-center gap-4">
                <p className="text-sm text-gray-500">确认无误后结束考试</p>
                <button
                  onClick={finishExam}
                  disabled={isTransitioning}
                  className={`px-10 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white text-lg font-bold rounded-2xl shadow-lg shadow-emerald-200/50 transition-all hover:shadow-emerald-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '离开考试'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Completed State */}
        {isCompleted && <CompletedState submitCount={submitCount} />}

        <div className="h-10" />
      </main>

      {/* Modals */}
      <ConfirmModal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={confirmSubmit}
        participantName={participantName}
        selectedTopicTitle={selectedTopic !== null ? EXAM_DATA.topics[selectedTopic].title : ''}
        mainFilesCount={
          questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.main.length || 0
        }
        interactionFilesCount={
          questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.interaction
            .length || 0
        }
        hasBonusAgent={
          (questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.bonusAgent
            .length || 0) > 0 ||
          (questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.linkValues?.bonusAgent ||
            '') !== ''
        }
        hasBonusMultimodal={
          (questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.bonusMultimodal
            .length || 0) > 0
        }
        supplementaryNotesLength={
          questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.supplementaryNotes.length ||
          0
        }
        supplementaryNotesFilesCount={
          questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.supplementaryNotesFiles
            ?.length || 0
        }
      />

      <SuccessModal isOpen={showSuccessModal} onClose={() => setShowSuccessModal(false)} />

      <EndExamConfirmModal
        isOpen={showEndExamConfirm}
        onClose={() => setShowEndExamConfirm(false)}
        onConfirm={confirmEndAnswering}
      />

      <LeaveExamConfirmModal
        isOpen={showLeaveExamConfirm}
        onClose={() => setShowLeaveExamConfirm(false)}
        onConfirm={confirmFinishExam}
      />
    </div>
  )
}
