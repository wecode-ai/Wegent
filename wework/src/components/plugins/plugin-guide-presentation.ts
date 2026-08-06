import type { TFunction } from 'i18next'

export type PluginGuideKind = 'analyze' | 'create' | 'review' | 'general'

export interface PluginGuideCapability {
  name: string
  description: string
  type: string
}

export interface PluginGuidePresentation {
  displayTitle: string
  generatedPrompt: string
  includedItems: string[]
  capabilityNames: string[]
  confirmation: {
    question: string
    defaultOptionId: string
    options: Array<{
      id: string
      label: string
      promptValue: string
    }>
  }
}

type GuideProfile =
  | 'site-sudoku'
  | 'site-dashboard'
  | 'site-portal'
  | 'site-general'
  | 'browser-checkout'
  | 'browser'
  | 'document'
  | 'spreadsheet'
  | 'review'
  | 'analyze'
  | 'create'
  | 'general'

function compactCapabilities(capabilities: PluginGuideCapability[]): PluginGuideCapability[] {
  const unique = new Map<string, PluginGuideCapability>()
  capabilities.forEach(capability => {
    const name = capability.name.trim()
    if (name && !unique.has(name)) unique.set(name, capability)
  })
  return Array.from(unique.values()).slice(0, 3)
}

function resolveProfile(kind: PluginGuideKind, source: string, scenario: string): GuideProfile {
  const isBrowser = /\b(browser|chrome)\b|control-in-app-browser|control-chrome|浏览器/i.test(
    source
  )
  if (isBrowser && /checkout|payment|order|结账|支付|订单/i.test(scenario)) {
    return 'browser-checkout'
  }
  if (isBrowser) return 'browser'

  const isSite = /\b(site|sites|website|web page|portal)\b|网站|网页|门户/i.test(source)
  if (isSite && /sudoku|数独/i.test(scenario)) return 'site-sudoku'
  if (isSite && /dashboard|看板|仪表盘|数据大屏/i.test(scenario)) return 'site-dashboard'
  if (isSite && /portal|new[- ]hire|onboarding|门户|入职/i.test(scenario)) return 'site-portal'
  if (isSite) return 'site-general'
  if (kind === 'review') return 'review'
  if (kind === 'analyze') return 'analyze'
  if (/document|documents|docs|文档/i.test(source)) return 'document'
  if (/spreadsheet|sheet|excel|表格/i.test(source)) return 'spreadsheet'
  if (kind === 'create') return 'create'
  return 'general'
}

function profileRequirements(
  profile: GuideProfile,
  projectName: string | null | undefined,
  t: TFunction<'common'>
): string[] {
  const requirements: Record<GuideProfile, string[]> = {
    'site-sudoku': [
      t(
        'workbench.plugin_guide_site_sudoku_daily',
        '按日期提供每日数独，并支持难度、计时和完成状态'
      ),
      t(
        'workbench.plugin_guide_site_sudoku_board',
        '实现 9×9 输入、候选数字、冲突提示、校验和重置'
      ),
      t(
        'workbench.plugin_guide_site_sudoku_leaderboard',
        '排行榜记录昵称、用时和日期，并处理并列与空状态'
      ),
      t(
        'workbench.plugin_guide_site_sudoku_delivery',
        '适配桌面与移动端，补齐加载、错误状态并提供可预览站点'
      ),
    ],
    'site-dashboard': [
      t('workbench.plugin_guide_site_dashboard_metrics', '明确核心指标、趋势和更新时间'),
      t('workbench.plugin_guide_site_dashboard_filters', '提供时间、状态和负责人筛选'),
      t('workbench.plugin_guide_site_dashboard_detail', '支持从汇总数据进入明细和异常项'),
      t('workbench.plugin_guide_site_delivery', '适配不同屏幕，补齐加载、空和错误状态'),
    ],
    'site-portal': [
      t('workbench.plugin_guide_site_portal_home', '设计清晰的首页入口和角色化导航'),
      t('workbench.plugin_guide_site_portal_tasks', '覆盖核心任务、进度和待办状态'),
      t('workbench.plugin_guide_site_portal_content', '组织资料、联系人和常见问题'),
      t('workbench.plugin_guide_site_delivery', '适配不同屏幕，补齐加载、空和错误状态'),
    ],
    'site-general': [
      t('workbench.plugin_guide_site_structure', '根据目标拆分页面、导航和信息层级'),
      t('workbench.plugin_guide_site_interactions', '实现主要操作流程和必要反馈'),
      t('workbench.plugin_guide_site_states', '补齐响应式、加载、空和错误状态'),
      t('workbench.plugin_guide_site_preview', '完成后提供可预览结果和实现说明'),
    ],
    'browser-checkout': [
      t('workbench.plugin_guide_browser_checkout_flow', '打开本地网站，按用户顺序走完结账流程'),
      t('workbench.plugin_guide_browser_checkout_checks', '检查金额、表单、跳转和错误提示'),
      t(
        'workbench.plugin_guide_browser_checkout_evidence',
        '记录失败步骤和页面现象，提交订单前先停下'
      ),
    ],
    browser: [
      t('workbench.plugin_guide_browser_flow', '打开目标网页，完成当前场景里的操作'),
      t('workbench.plugin_guide_browser_checks', '检查页面反馈、跳转和异常提示'),
      t(
        'workbench.plugin_guide_browser_evidence',
        '记录失败步骤和页面现象，不执行未经确认的提交或删除'
      ),
    ],
    document: [
      t('workbench.plugin_guide_document_source', '保留原始事实和关键信息，不补造未知内容'),
      t('workbench.plugin_guide_document_structure', '根据任务建立标题、正文和下一步结构'),
      t('workbench.plugin_guide_document_editable', '生成可继续编辑的文档，而不是纯文本摘要'),
      t('workbench.plugin_guide_result_check', '完成后检查结构、遗漏项和格式一致性'),
    ],
    spreadsheet: [
      t('workbench.plugin_guide_sheet_structure', '规划工作表、字段、数据类型和输入区域'),
      t('workbench.plugin_guide_sheet_logic', '使用公式或规则完成计算并避免硬编码结果'),
      t('workbench.plugin_guide_sheet_readability', '统一格式，突出输入、结果和异常数据'),
      t('workbench.plugin_guide_result_check', '完成后检查结构、遗漏项和格式一致性'),
    ],
    review: [
      projectName
        ? t('workbench.plugin_guide_review_project', {
            project: projectName,
            defaultValue: `检查 ${projectName} 中本次场景指定的代码范围`,
          })
        : t('workbench.plugin_guide_review_scope', '检查本次场景指定的代码或变更范围'),
      t('workbench.plugin_guide_review_risks', '重点验证正确性、安全性、可靠性和测试风险'),
      t('workbench.plugin_guide_review_evidence', '每个问题给出证据、文件位置和影响'),
      t('workbench.plugin_guide_review_summary', '按严重程度组织结果，并说明未发现的问题'),
    ],
    analyze: [
      t('workbench.plugin_guide_analyze_source', '先确认数据来源、字段、范围和统计口径'),
      t('workbench.plugin_guide_analyze_drivers', '比较趋势、异常和可能的驱动因素'),
      t('workbench.plugin_guide_analyze_evidence', '结论必须对应数据证据并注明限制'),
      t('workbench.plugin_guide_analyze_output', '用清晰的表格、图表或行动建议呈现结果'),
    ],
    create: [
      t('workbench.plugin_guide_create_source', '保留输入材料中的事实和限制条件'),
      t('workbench.plugin_guide_create_structure', '围绕使用场景组织内容和信息层级'),
      t('workbench.plugin_guide_create_editable', '生成可编辑结果并标出仍需补充的信息'),
      t('workbench.plugin_guide_result_check', '完成后检查结构、遗漏项和格式一致性'),
    ],
    general: [
      t('workbench.plugin_guide_general_goal', '以当前使用场景作为明确任务目标'),
      t('workbench.plugin_guide_general_capability', '优先使用当前插件提供的能力完成任务'),
      t('workbench.plugin_guide_general_gaps', '缺少必要信息时先指出具体缺口'),
      t('workbench.plugin_guide_general_result', '返回可检查、可继续修改的结果'),
    ],
  }
  return requirements[profile]
}

function profileConfirmation(
  profile: GuideProfile,
  t: TFunction<'common'>
): PluginGuidePresentation['confirmation'] {
  const confirmations: Record<GuideProfile, PluginGuidePresentation['confirmation']> = {
    'site-sudoku': {
      question: t('workbench.plugin_guide_question_sudoku', '排行榜如何展示玩家？'),
      defaultOptionId: 'nickname',
      options: [
        {
          id: 'nickname',
          label: t('workbench.plugin_guide_option_sudoku_nickname', '显示昵称'),
          promptValue: t(
            'workbench.plugin_guide_option_sudoku_nickname_prompt',
            '排行榜显示玩家昵称、完成用时和日期'
          ),
        },
        {
          id: 'anonymous',
          label: t('workbench.plugin_guide_option_sudoku_anonymous', '匿名排行'),
          promptValue: t(
            'workbench.plugin_guide_option_sudoku_anonymous_prompt',
            '排行榜使用匿名编号，只显示完成用时和日期'
          ),
        },
        {
          id: 'none',
          label: t('workbench.plugin_guide_option_sudoku_none', '暂不启用'),
          promptValue: t(
            'workbench.plugin_guide_option_sudoku_none_prompt',
            '首个版本暂不启用排行榜，但保留后续接入位置'
          ),
        },
      ],
    },
    'site-dashboard': {
      question: t('workbench.plugin_guide_question_dashboard', '默认展示多长时间的数据？'),
      defaultOptionId: '30-days',
      options: [
        {
          id: '7-days',
          label: t('workbench.plugin_guide_option_7_days', '近 7 天'),
          promptValue: t('workbench.plugin_guide_option_7_days_prompt', '默认展示最近 7 天的数据'),
        },
        {
          id: '30-days',
          label: t('workbench.plugin_guide_option_30_days', '近 30 天'),
          promptValue: t(
            'workbench.plugin_guide_option_30_days_prompt',
            '默认展示最近 30 天的数据'
          ),
        },
        {
          id: '90-days',
          label: t('workbench.plugin_guide_option_90_days', '近 90 天'),
          promptValue: t(
            'workbench.plugin_guide_option_90_days_prompt',
            '默认展示最近 90 天的数据'
          ),
        },
      ],
    },
    'site-portal': {
      question: t('workbench.plugin_guide_question_portal', '这个门户主要给谁使用？'),
      defaultOptionId: 'both',
      options: [
        {
          id: 'new-hires',
          label: t('workbench.plugin_guide_option_new_hires', '新员工'),
          promptValue: t('workbench.plugin_guide_option_new_hires_prompt', '主要面向新员工使用'),
        },
        {
          id: 'managers',
          label: t('workbench.plugin_guide_option_managers', '管理者'),
          promptValue: t('workbench.plugin_guide_option_managers_prompt', '主要面向管理者使用'),
        },
        {
          id: 'both',
          label: t('workbench.plugin_guide_option_both_roles', '两者都需要'),
          promptValue: t(
            'workbench.plugin_guide_option_both_roles_prompt',
            '同时支持新员工和管理者，并提供对应入口'
          ),
        },
      ],
    },
    'site-general': {
      question: t('workbench.plugin_guide_question_site_version', '先生成哪个版本？'),
      defaultOptionId: 'complete',
      options: [
        {
          id: 'complete',
          label: t('workbench.plugin_guide_option_complete', '可用完整版本'),
          promptValue: t(
            'workbench.plugin_guide_option_complete_prompt',
            '先生成核心流程可用的完整版本'
          ),
        },
        {
          id: 'prototype',
          label: t('workbench.plugin_guide_option_prototype', '快速原型'),
          promptValue: t(
            'workbench.plugin_guide_option_prototype_prompt',
            '先生成用于确认方向的快速原型'
          ),
        },
        {
          id: 'structure',
          label: t('workbench.plugin_guide_option_structure', '只搭页面结构'),
          promptValue: t(
            'workbench.plugin_guide_option_structure_prompt',
            '先完成页面结构和主要导航'
          ),
        },
      ],
    },
    'browser-checkout': {
      question: t('workbench.plugin_guide_question_browser_checkout', '测试到哪一步？'),
      defaultOptionId: 'before-submit',
      options: [
        {
          id: 'before-submit',
          label: t('workbench.plugin_guide_option_browser_before_submit', '提交订单前停止'),
          promptValue: t(
            'workbench.plugin_guide_option_browser_before_submit_prompt',
            '完成结账流程检查，但在最终提交订单前停止'
          ),
        },
        {
          id: 'test-order',
          label: t('workbench.plugin_guide_option_browser_test_order', '提交测试订单'),
          promptValue: t(
            'workbench.plugin_guide_option_browser_test_order_prompt',
            '确认处于测试环境后，可以提交一笔测试订单'
          ),
        },
        {
          id: 'observe-only',
          label: t('workbench.plugin_guide_option_browser_observe_only', '只检查页面'),
          promptValue: t(
            'workbench.plugin_guide_option_browser_observe_only_prompt',
            '只查看页面和交互入口，不填写或提交表单'
          ),
        },
      ],
    },
    browser: {
      question: t('workbench.plugin_guide_question_browser', '网页操作到什么程度？'),
      defaultOptionId: 'complete-steps',
      options: [
        {
          id: 'complete-steps',
          label: t('workbench.plugin_guide_option_browser_complete', '完成场景步骤'),
          promptValue: t(
            'workbench.plugin_guide_option_browser_complete_prompt',
            '自动完成场景中的可逆操作，遇到提交或删除时先确认'
          ),
        },
        {
          id: 'confirm-each',
          label: t('workbench.plugin_guide_option_browser_confirm_each', '每一步先确认'),
          promptValue: t(
            'workbench.plugin_guide_option_browser_confirm_each_prompt',
            '执行每一步网页操作前先向我确认'
          ),
        },
        {
          id: 'observe-only',
          label: t('workbench.plugin_guide_option_browser_observe', '只观察不操作'),
          promptValue: t(
            'workbench.plugin_guide_option_browser_observe_prompt',
            '只观察页面并给出结果，不点击或填写内容'
          ),
        },
      ],
    },
    document: {
      question: t('workbench.plugin_guide_question_document', '先生成到什么程度？'),
      defaultOptionId: 'draft',
      options: [
        {
          id: 'outline',
          label: t('workbench.plugin_guide_option_outline', '内容大纲'),
          promptValue: t('workbench.plugin_guide_option_outline_prompt', '先生成内容大纲供我确认'),
        },
        {
          id: 'draft',
          label: t('workbench.plugin_guide_option_draft', '完整初稿'),
          promptValue: t(
            'workbench.plugin_guide_option_draft_prompt',
            '直接生成结构完整的可编辑初稿'
          ),
        },
        {
          id: 'detailed',
          label: t('workbench.plugin_guide_option_detailed', '详细版本'),
          promptValue: t(
            'workbench.plugin_guide_option_detailed_prompt',
            '生成包含充分细节的完整版本'
          ),
        },
      ],
    },
    spreadsheet: {
      question: t('workbench.plugin_guide_question_sheet', '这个表格主要用来做什么？'),
      defaultOptionId: 'analysis',
      options: [
        {
          id: 'input',
          label: t('workbench.plugin_guide_option_input', '收集录入'),
          promptValue: t(
            'workbench.plugin_guide_option_input_prompt',
            '优先设计清晰的数据录入和校验流程'
          ),
        },
        {
          id: 'analysis',
          label: t('workbench.plugin_guide_option_analysis', '分析数据'),
          promptValue: t(
            'workbench.plugin_guide_option_analysis_prompt',
            '优先完成指标计算、分析和可视化'
          ),
        },
        {
          id: 'tracking',
          label: t('workbench.plugin_guide_option_tracking', '跟踪进度'),
          promptValue: t(
            'workbench.plugin_guide_option_tracking_prompt',
            '优先设计状态、负责人和进度跟踪'
          ),
        },
      ],
    },
    review: {
      question: t('workbench.plugin_guide_question_review', '这次最关注什么？'),
      defaultOptionId: 'test-quality',
      options: [
        {
          id: 'merge-risk',
          label: t('workbench.plugin_guide_option_review_quick', '合并风险'),
          promptValue: t(
            'workbench.plugin_guide_option_review_quick_prompt',
            '重点检查会阻塞合并的正确性与安全问题'
          ),
        },
        {
          id: 'test-quality',
          label: t('workbench.plugin_guide_option_review_standard', '测试质量'),
          promptValue: t(
            'workbench.plugin_guide_option_review_standard_prompt',
            '重点检查缺失测试、边界条件和回归风险'
          ),
        },
        {
          id: 'architecture',
          label: t('workbench.plugin_guide_option_review_deep', '架构影响'),
          promptValue: t(
            'workbench.plugin_guide_option_review_deep_prompt',
            '重点检查模块边界、性能和长期维护成本'
          ),
        },
      ],
    },
    analyze: {
      question: t('workbench.plugin_guide_question_analyze', '结果优先呈现什么？'),
      defaultOptionId: 'insights',
      options: [
        {
          id: 'insights',
          label: t('workbench.plugin_guide_option_insights', '结论建议'),
          promptValue: t(
            'workbench.plugin_guide_option_insights_prompt',
            '优先给出关键结论和行动建议'
          ),
        },
        {
          id: 'charts',
          label: t('workbench.plugin_guide_option_charts', '图表趋势'),
          promptValue: t('workbench.plugin_guide_option_charts_prompt', '优先用图表呈现趋势和异常'),
        },
        {
          id: 'report',
          label: t('workbench.plugin_guide_option_report', '完整报告'),
          promptValue: t(
            'workbench.plugin_guide_option_report_prompt',
            '生成包含方法、证据和结论的完整报告'
          ),
        },
      ],
    },
    create: {
      question: t('workbench.plugin_guide_question_create', '希望先得到什么？'),
      defaultOptionId: 'draft',
      options: [
        {
          id: 'ideas',
          label: t('workbench.plugin_guide_option_ideas', '几个方向'),
          promptValue: t(
            'workbench.plugin_guide_option_ideas_prompt',
            '先提供几个可比较的创作方向'
          ),
        },
        {
          id: 'outline',
          label: t('workbench.plugin_guide_option_outline', '内容大纲'),
          promptValue: t('workbench.plugin_guide_option_outline_prompt', '先生成内容大纲供我确认'),
        },
        {
          id: 'draft',
          label: t('workbench.plugin_guide_option_draft', '完整初稿'),
          promptValue: t(
            'workbench.plugin_guide_option_draft_prompt',
            '直接生成结构完整的可编辑初稿'
          ),
        },
      ],
    },
    general: {
      question: t('workbench.plugin_guide_question_general', '希望怎么开始？'),
      defaultOptionId: 'recommended',
      options: [
        {
          id: 'recommended',
          label: t('workbench.plugin_guide_option_recommended', '按推荐方案'),
          promptValue: t(
            'workbench.plugin_guide_option_recommended_prompt',
            '按插件推荐的默认方案开始'
          ),
        },
        {
          id: 'quick',
          label: t('workbench.plugin_guide_option_quick', '先快速处理'),
          promptValue: t('workbench.plugin_guide_option_quick_prompt', '先快速完成核心任务'),
        },
        {
          id: 'clarify',
          label: t('workbench.plugin_guide_option_clarify', '先问清需求'),
          promptValue: t(
            'workbench.plugin_guide_option_clarify_prompt',
            '开始前先向我确认必要信息'
          ),
        },
      ],
    },
  }
  return confirmations[profile]
}

function profileDisplayTitle(profile: GuideProfile, title: string, t: TFunction<'common'>): string {
  if (profile === 'browser-checkout') {
    return t('workbench.plugin_guide_title_browser_checkout', '测试本地结账流程')
  }
  return title
}

export function inferPluginGuideKind(prompt: string): PluginGuideKind {
  const normalized = prompt.toLowerCase()
  if (
    /\b(?:analyze|analysis|data|financial|spreadsheet|table|extract)\b|统计|数据|财务|表格|提取/.test(
      normalized
    )
  ) {
    return 'analyze'
  }
  if (/\b(?:create|draft|build|write|generate)\b|制作|创建|撰写|生成/.test(normalized)) {
    return 'create'
  }
  if (/\b(?:review|inspect|verify|audit|check)\b|审查|检查|验证|核对/.test(normalized)) {
    return 'review'
  }
  return 'general'
}

function buildPrompt({ title }: { title: string }): string {
  return title.trim()
}

export function buildPluginGuidePresentation({
  kind,
  prompt,
  title,
  pluginName,
  pluginDescription,
  capabilities,
  projectName,
  t,
}: {
  kind: PluginGuideKind
  prompt: string
  title: string
  pluginName: string
  pluginDescription: string
  capabilities: PluginGuideCapability[]
  projectName?: string | null
  t: TFunction<'common'>
}): PluginGuidePresentation {
  const relevantCapabilities = compactCapabilities(capabilities)
  const source = [
    pluginName,
    pluginDescription,
    ...relevantCapabilities.flatMap(item => [item.name, item.description]),
  ].join(' ')
  const profile = resolveProfile(kind, source, `${title} ${prompt}`)
  const includedItems = profileRequirements(profile, projectName, t)

  return {
    displayTitle: profileDisplayTitle(profile, title, t),
    generatedPrompt: buildPrompt({
      title,
    }),
    includedItems,
    capabilityNames: relevantCapabilities.map(item => item.name),
    confirmation: profileConfirmation(profile, t),
  }
}
