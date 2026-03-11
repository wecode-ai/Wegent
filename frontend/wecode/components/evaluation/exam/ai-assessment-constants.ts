// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Topic } from '@wecode/components/evaluation/exam'

export const EXAM_DATA = {
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
      text: '请按要求提交作答说明、AI交互过程记录及产出报告/方案；如选答附加题，可补充提交 Agent或多模态交付物等相关材料',
    },
    {
      icon: 'shield',
      label: '公平原则',
      text: '为确保公平性，现场不得直接使用过往工作产出作为结果提交',
    },
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
    '在时间有限题目难度大的情况下，本次AI应用考试更多是考量在与AI工具交互过程中驾驭工具的能力，但也需要尽量保证产出结果的完成可靠性。',
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
        '如参与"可自动运行的 Agent / Skill"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
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
        '如参与"可自动运行的 Agent / Skill"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
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
        '如参与"可自动运行的 Agent / Skill"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
        '如参与"多模态应用"，请上传基于本次作答生成的多模态交付物，如 PPT、结构图、信息图、短视频等',
        '附加题材料用于加分评审，均为可选填。',
      ],
    },
  ] as Topic[],
  bonusItems: [
    {
      id: 1,
      title: '可自动运行的 Agent / Skill',
      description:
        '基于本次考试题目，搭建一个可自动运行的 Agent / Skill，使其能够在指定频率（如每周、每月）或按需触发时，围绕题目要求自动完成“信息获取→结构化处理→按既定模板生成草稿→标注来源与不确定点”的完整流程。输出模板可随题目不同而调整，但需体现完整、可复用的自动化闭环能力。',
      platforms:
        '实现形态（不限）：Wegent、扣子、Manus、ChatGPT / Claude、Gemini 等支持 Agent、Skill 或类似能力配置的工具均可。',
      deliverables: [
        '可访问、可运行的 Agent / Skill 分享链接或可复现配置（评审可触发运行）',
        '设计方案、能力配置截图或关键节点说明（体现输入、处理步骤与输出结果）',
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

export const UPLOAD_SLOTS_CONFIG = [
  {
    key: 'interaction',
    label: '交互过程记录',
    hint: '支持 PDF、图片、文本等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.html,.json',
    iconName: 'pen',
    iconClass: 'text-gray-400',
  },
  {
    key: 'main',
    label: '产出报告及方案',
    hint: '支持 PDF、Word、TXT 等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.rtf,.pages',
    iconName: 'file',
    iconClass: 'text-[#DF2029]',
  },
  {
    key: 'bonusAgent',
    label: '附加题一：Agent / Skill',
    hint: '支持图片、PDF、文档等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.pptx,.ppt,.html',
    iconName: 'workflow',
    iconClass: 'text-indigo-500',
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
    iconName: 'layers',
    iconClass: 'text-rose-500',
  },
] as const

/**
 * AI Assessment 2026 Exam Data V2
 *
 * This file contains the exam data for the second AI assessment exam.
 *
 * Topic ID: 2
 * Question IDs: 4, 5
 */

export const EXAM_DATA_V2 = {
  title: '微博高管AI应用能力考核（二）',
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
      text: '请按要求提交作答说明、AI交互过程记录及产出报告/方案；如选答附加题，可补充提交 Agent或多模态交付物等相关材料',
    },
    {
      icon: 'shield',
      label: '公平原则',
      text: '为确保公平性，现场不得直接使用过往工作产出作为结果提交',
    },
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
    '在时间有限题目难度大的情况下，本次AI应用考试更多是考量在与AI工具交互过程中驾驭工具的能力，但也需要尽量保证产出结果的完成可靠性。',
  topics: [
    {
      id: 4,
      title: 'AI 时代的组织重构与管理范式升级——2026 年部门管理者角色转型方案',
      shortDesc: '分析AI对组织的影响，提出管理者角色转型方案',
      icon: 'robot',
      context:
        '在 AI Agent、自动化决策与智能协作工具快速渗透的背景下，传统以"人力规模 + 层级管理"为核心的组织模式正在发生变化。2026 年前后，部门管理者的核心价值可能从"资源调度者"转向"目标设计者、系统治理者与风险把控者"。',
      contextSuffix: '请你站在 部门 VP / 一级负责人 视角，运用 AI 工具完成以下任务：',
      tasks: [
        {
          name: '组织影响评估',
          desc: '分析 AI Agent / 自动化系统对当前部门组织结构、岗位分工、管理半径的影响，明确哪些管理职责正在被削弱、替代或放大。',
        },
        {
          name: '角色重构方案',
          desc: '提出 2026 年部门管理者（VP / 总监 / 核心负责人）的角色变化模型，包括关键能力变化与决策重心迁移。',
        },
        {
          name: '组织提效设计',
          desc: '设计一套"人 + AI + Agent"协作下的新型组织运作机制（如汇报关系、决策节奏、目标拆解方式），并量化可能带来的管理效率或决策质量提升。',
        },
      ],
      requirement:
        '要求：数据或案例可查、逻辑自洽、结论可落地。交付内容：一份文档，篇幅不限（pdf、word、钉钉文档均可），内容包括组织影响分析 + 管理角色转型方案 + 量化收益判断。',
      deliverable: [
        '1. 提交与 AI 的交互过程记录，优先使用工具自带的导出功能，也可通过分享对话、使用浏览器导出当前对话页面为 PDF，或复制整理到文档中提交',
        '2. 提交题目要求的正式产出报告，即本次调研/分析的最终文档（支持 PDF、Word等）',
        '3. 请在"作答补充说明"对话框中简要说明本次借助 AI 完成作答的整体思路。',
      ],
      bonusDeliverable: [
        '如参与"可自动运行的 Agent / Skill"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
        '如参与"多模态应用"，请上传基于本次作答生成的多模态交付物，如 PPT、结构图、信息图、短视频等',
        '附加题材料用于加分评审，均为可选填。',
      ],
    },
    {
      id: 5,
      title: 'AI 参与下的公共决策与社会系统效率——一个非商业系统的 AI 应用推演',
      shortDesc: '选择非商业场景，推演AI在公共决策中的应用',
      icon: 'globe',
      context:
        '请选择一个 非互联网公司、非商业竞争场景（如：城市交通、医疗资源分配、教育资源配置、公共舆情治理等），设想 AI Agent 在其中作为"执行与决策支持系统"的角色，完成以下分析：',
      tasks: [
        {
          name: '系统问题拆解',
          desc: '明确该公共系统当前的核心效率瓶颈与结构性问题。',
        },
        {
          name: 'AI 介入方式',
          desc: '分析 AI Agent 可以在哪些关键节点介入决策或执行流程，以及其能力边界。',
        },
        {
          name: '效果推演',
          desc: '对 AI 介入后 1–2 年内的系统效率变化进行推演（指标不求绝对准确，但逻辑需可验证）。',
        },
        {
          name: '风险与约束',
          desc: '分析该场景下 AI 应用可能带来的治理风险与约束条件。',
        },
      ],
      requirement:
        '要求：不依赖个人业务经验，强调抽象建模能力与系统性思考。交付内容：一份文档，篇幅不限（pdf、word、钉钉文档均可），内容包括 系统分析报告 + AI 介入推演 + 风险判断。',
      deliverable: [
        '1. 提交与 AI 的交互过程记录，优先使用工具自带的导出功能，也可通过分享对话、使用浏览器导出当前对话页面为 PDF，或复制整理到文档中提交',
        '2. 提交题目要求的正式产出报告，即本次调研/分析的最终文档（支持 PDF、Word等）',
        '3. 请在"作答补充说明"对话框中简要说明本次借助 AI 完成作答的整体思路。',
      ],
      bonusDeliverable: [
        '如参与"可自动运行的 Agent / Skill"，请提交可访问/可运行的 Agent 分享链接，或设计方案',
        '如参与"多模态应用"，请上传基于本次作答生成的多模态交付物，如 PPT、结构图、信息图、短视频等',
        '附加题材料用于加分评审，均为可选填。',
      ],
    },
  ] as Topic[],
  bonusItems: [
    {
      id: 1,
      title: '可自动运行的 Agent / Skill',
      description:
        '基于本次考试题目，搭建一个可自动运行的 Agent / Skill，使其能够在指定频率（如每周、每月）或按需触发时，围绕题目要求自动完成"信息获取→结构化处理→按既定模板生成草稿→标注来源与不确定点"的完整流程。输出模板可随题目不同而调整，但需体现完整、可复用的自动化闭环能力。',
      platforms:
        '实现形态（不限）：Wegent、扣子、Manus、ChatGPT / Claude、Gemini 等支持 Agent、Skill 或类似能力配置的工具均可。',
      deliverables: [
        '可访问、可运行的 Agent / Skill 分享链接或可复现配置（评审可触发运行）',
        '设计方案、能力配置截图或关键节点说明（体现输入、处理步骤与输出结果）',
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

export const UPLOAD_SLOTS_CONFIG_V2 = [
  {
    key: 'interaction',
    label: '交互过程记录',
    hint: '支持 PDF、图片、文本等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.html,.json',
    iconName: 'pen',
    iconClass: 'text-gray-400',
  },
  {
    key: 'main',
    label: '产出报告及方案',
    hint: '支持 PDF、Word、TXT 等格式，最多可上传 20 个文件',
    required: true,
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.txt,.md,.rtf,.pages',
    iconName: 'file',
    iconClass: 'text-[#DF2029]',
  },
  {
    key: 'bonusAgent',
    label: '附加题一：Agent / Skill',
    hint: '支持图片、PDF、文档等格式，最多可上传 20 个文件',
    maxFiles: 20,
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,.pptx,.ppt,.html',
    iconName: 'workflow',
    iconClass: 'text-indigo-500',
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
    iconName: 'layers',
    iconClass: 'text-rose-500',
  },
] as const
