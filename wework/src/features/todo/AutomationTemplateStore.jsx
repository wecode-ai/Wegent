import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Clock3,
  Code2,
  GitBranch,
  LayoutGrid,
  Search,
  Sparkles,
  Webhook,
  X,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { automationClass } from './automationStyles'
import { triggerPresentation } from './AutomationRuleModel.jsx'

export const automationTemplates = [
  {
    id: 'issue-development',
    category: 'issue',
    featured: true,
    name: 'Issue 自动开发',
    description: '创建 Issue 后自动分析需求、实现代码并回写结果',
    tags: ['Issue', '研发'],
    icon: 'development',
    trigger: {
      type: 'event',
      source: 'wework',
      collectionMode: 'webhook',
      startMode: 'immediate',
      event: 'created',
      tags: ['自动开发'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '分析需求',
        prompt: '阅读 Issue 的标题、描述和附件，理解目标、范围和验收标准。',
        deliverables: [
          {
            name: '需求分析',
            description: '目标、范围、约束与验收标准',
            valueType: 'text',
          },
        ],
        plugins: ['Wework 项目空间'],
      },
      {
        name: '实现与验证',
        prompt: '根据需求分析修改代码并运行相关测试，保留可验证的执行证据。',
        deliverables: [
          {
            name: '实现结果',
            description: '代码改动与测试结果',
            valueType: 'text',
          },
        ],
        plugins: ['GitHub', 'Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
      {
        name: '回写 Issue',
        prompt: '将实现结果、验证证据和后续建议回写当前 Issue。',
        deliverables: [
          {
            name: 'Issue 更新',
            description: '结果、证据和后续建议',
            valueType: 'text',
          },
        ],
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'issue-testing',
    category: 'issue',
    featured: true,
    name: 'Issue 自动测试',
    description: '创建测试任务后自动确定范围、运行测试并更新验收结果',
    tags: ['Issue', '测试'],
    icon: 'testing',
    trigger: {
      type: 'event',
      source: 'wework',
      startMode: 'immediate',
      event: 'created',
      tags: ['自动测试'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '确定测试范围',
        prompt: '根据 Issue 描述和代码变更识别需要执行的测试集合。',
        plugins: ['GitHub', 'Wework 项目空间'],
      },
      {
        name: '运行测试',
        prompt: '运行相关自动化测试，定位失败原因并收集可复现日志。',
        plugins: ['GitHub'],
        workspacePolicy: 'inherit',
      },
      {
        name: '更新验收结果',
        prompt: '将测试结论、失败日志和验收建议回写 Issue。',
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'daily-inspection',
    category: 'schedule',
    featured: true,
    name: '每日 Issue 巡检',
    description: '每天检查待处理和长期未更新的 Issue，生成行动建议',
    tags: ['定时', '巡检'],
    icon: 'schedule',
    trigger: {
      type: 'schedule',
      source: 'wework',
      startMode: 'immediate',
      event: 'created',
      tags: [],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '09:30',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '检查看板',
        prompt: '检查项目看板中的待处理和长时间未更新事项，识别优先级、依赖和风险。',
      },
      {
        name: '生成巡检报告',
        prompt: '汇总需要关注的 Issue，并为每项给出明确的下一步行动建议。',
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'issue-defect-triage',
    category: 'issue',
    featured: false,
    name: '缺陷自动分析',
    description: '新缺陷创建后自动复现、定位原因并给出修复建议',
    tags: ['Issue', '缺陷'],
    icon: 'defect',
    trigger: {
      type: 'event',
      source: 'wework',
      startMode: 'status',
      event: 'created',
      tags: ['缺陷'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '复现缺陷',
        prompt: '阅读缺陷描述和附件，按照复现步骤验证问题并补充必要信息。',
        plugins: ['GitHub', 'Wework 项目空间'],
      },
      {
        name: '定位原因',
        prompt: '分析相关代码和日志，定位最可能的根因及影响范围。',
        plugins: ['GitHub'],
        workspacePolicy: 'inherit',
      },
      {
        name: '给出修复建议',
        prompt: '整理根因、修复方案、验证方式和风险，并回写当前 Issue。',
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
]

export function TemplateStore({ templates, onClose, onApply }) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState(templates[0]?.id)
  const normalizedQuery = query.trim().toLowerCase()

  const visibleTemplates = useMemo(
    () =>
      templates.filter(template => {
        const matchesCategory =
          category === 'all' ||
          (category === 'featured' ? template.featured : template.category === category)
        const matchesQuery =
          !normalizedQuery ||
          `${template.name} ${template.description} ${template.tags.join(' ')}`
            .toLowerCase()
            .includes(normalizedQuery)
        return matchesCategory && matchesQuery
      }),
    [category, normalizedQuery, templates]
  )

  const selectedTemplate =
    visibleTemplates.find(template => template.id === selectedId) ?? visibleTemplates[0] ?? null

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className={automationClass('template-store-overlay')}
      data-testid="template-store"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className={automationClass('template-store-dialog')} role="dialog" aria-modal="true">
        <header className={automationClass('template-store-header')}>
          <div>
            <span className={automationClass('template-store-mark')}>
              <Sparkles size={18} />
            </span>
            <div>
              <h2>自动化模板</h2>
              <p>选择模板后会生成一份独立配置，可继续修改</p>
            </div>
          </div>
          <label className={automationClass('template-search')}>
            <Search size={15} />
            <input
              data-testid="template-search-input"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索模板"
              autoFocus
            />
            {query ? (
              <button
                type="button"
                data-testid="clear-template-search"
                onClick={() => setQuery('')}
                aria-label="清除模板搜索"
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          <button
            className={automationClass('template-store-close')}
            type="button"
            data-testid="close-template-store"
            onClick={onClose}
            aria-label="关闭模板商店"
          >
            <X size={17} />
          </button>
        </header>

        <div className={automationClass('template-store-body')}>
          <nav className={automationClass('template-categories')} aria-label="模板分类">
            {[
              ['all', '全部模板', LayoutGrid],
              ['featured', '推荐', Sparkles],
              ['issue', 'Issue 触发', Webhook],
              ['schedule', '定时任务', Clock3],
            ].map(([value, label, Icon]) => (
              <button
                key={value}
                className={category === value ? 'active' : ''}
                type="button"
                data-testid={`template-category-${value}`}
                onClick={() => setCategory(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </nav>

          <main className={automationClass('template-library')}>
            <div className={automationClass('template-library-title')}>
              <div>
                <h3>
                  {category === 'all'
                    ? '全部模板'
                    : category === 'featured'
                      ? '推荐模板'
                      : category === 'issue'
                        ? 'Issue 触发'
                        : '定时任务'}
                </h3>
                <span>{visibleTemplates.length} 个模板</span>
              </div>
              <small>内置模板</small>
            </div>

            {visibleTemplates.length ? (
              <div className={automationClass('template-grid')}>
                {visibleTemplates.map(template => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    selected={selectedTemplate?.id === template.id}
                    onSelect={() => setSelectedId(template.id)}
                    onApply={() => onApply(template)}
                  />
                ))}
              </div>
            ) : (
              <div className={automationClass('template-empty')}>
                <Search size={22} />
                <strong>没有找到相关模板</strong>
                <span>换个关键词或分类试试。</span>
              </div>
            )}
          </main>

          <aside className={automationClass('template-preview')}>
            {selectedTemplate ? (
              <>
                <div className={automationClass('template-preview-head')}>
                  <TemplateIcon type={selectedTemplate.icon} />
                  <div>
                    <small>模板预览</small>
                    <h3>{selectedTemplate.name}</h3>
                  </div>
                </div>
                <p>{selectedTemplate.description}</p>
                <div className={automationClass('template-preview-trigger')}>
                  <span>
                    {selectedTemplate.trigger.type === 'schedule' ? (
                      <Clock3 size={15} />
                    ) : (
                      <Webhook size={15} />
                    )}
                  </span>
                  <div>
                    <small>触发规则</small>
                    <strong>{triggerPresentation(selectedTemplate.trigger, t).label}</strong>
                  </div>
                </div>
                <div className={automationClass('template-preview-steps')}>
                  <small>执行流程 · {selectedTemplate.steps.length} 个节点</small>
                  {selectedTemplate.steps.map((step, index) => (
                    <div key={`${selectedTemplate.id}-${step.name}`}>
                      <span>{index + 1}</span>
                      <strong>{step.name}</strong>
                    </div>
                  ))}
                </div>
                <div className={automationClass('template-preview-footer')}>
                  <p>应用后生成独立自动化，不会与模板保持引用关系。</p>
                  <button
                    type="button"
                    data-testid="apply-selected-template"
                    onClick={() => onApply(selectedTemplate)}
                  >
                    使用此模板
                  </button>
                </div>
              </>
            ) : (
              <div className={automationClass('template-preview-empty')}>选择一个模板查看配置</div>
            )}
          </aside>
        </div>
      </section>
    </div>
  )
}

export function TemplateCard({ template, selected, onSelect, onApply }) {
  const { t } = useTranslation('common')
  const trigger = triggerPresentation(template.trigger, t)
  return (
    <article className={automationClass(`template-card ${selected ? 'selected' : ''}`)}>
      <button
        className={automationClass('template-card-main')}
        type="button"
        data-testid={`template-card-${template.id}`}
        onClick={onSelect}
      >
        <TemplateIcon type={template.icon} />
        <span className={automationClass('template-card-copy')}>
          <span>
            <strong>{template.name}</strong>
            {template.featured ? <small>推荐</small> : null}
          </span>
          <p>{template.description}</p>
          <span className={automationClass('template-card-meta')}>
            <span>{trigger.label}</span>
            <span>{template.steps.length} 个节点</span>
          </span>
        </span>
      </button>
      <button
        className={automationClass('template-card-apply')}
        type="button"
        data-testid={`apply-template-${template.id}`}
        onClick={onApply}
      >
        使用
      </button>
    </article>
  )
}

export function TemplateIcon({ type }) {
  const Icon =
    type === 'schedule'
      ? Clock3
      : type === 'testing'
        ? CheckCircle2
        : type === 'defect'
          ? GitBranch
          : Code2
  return (
    <span className={automationClass(`template-icon ${type}`)}>
      <Icon size={18} />
    </span>
  )
}
