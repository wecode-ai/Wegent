import { QuickPhrasesEditor } from '@wegent/collaboration/composer/QuickPhrasesEditor'
import { defaultQuickPhrases } from '@wegent/chat-core/composer-quick-phrases'
import { useTranslation } from '@/hooks/useTranslation'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Bot, CalendarClock, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  DesktopSidebarNavItem,
  DesktopSidebarSectionHeader,
} from '@/components/layout/DesktopSidebarPrimitives'
import { RuntimeInteractionNotice } from '@/features/notifications/RuntimeInteractionNotice'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from '@/features/notifications/RuntimeInteractionsContext'
import {
  interactionTask,
  interactionQuestion,
} from '@/features/notifications/runtimeInteractions.fixtures'
import type { RuntimeInteraction } from '@/features/notifications/runtimeInteractions'

const meta = {
  title: 'Business/ContentLayout',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const exampleNotice: RuntimeInteraction = {
  id: 'catalog-layout-notice',
  requestKey: 'catalog-layout-question',
  task: interactionTask,
  payload: interactionQuestion,
  question:
    '请确认项目设置与本周的执行安排。长通知应在卡片内自然换行，包括没有空格的链接 https://example.invalid/a-very-long-path-that-must-remain-inside-the-notification-card-and-never-overlap-adjacent-content 。',
  createdAt: Date.UTC(2026, 10, 1),
  answered: false,
}

export const NavigationAndLongNotice: Story = {
  render: function Example() {
    const [opened, setOpened] = useState('')
    const [expanded, setExpanded] = useState(true)
    const [drafts, setDrafts] = useState<Record<string, string>>({})
    const [notice, setNotice] = useState<RuntimeInteraction | null>(exampleNotice)
    const value: RuntimeInteractionsValue = {
      pending: [exampleNotice],
      history: [],
      errors: {},
      drafts,
      replyDrafts: [],
      busy: new Set(),
      loading: false,
      setDraft: (id, text) => setDrafts(previous => ({ ...previous, [id]: text })),
      discardDraft: async () => false,
      respond: async () => {
        setOpened('reply-sent')
        setNotice(null)
        return true
      },
      dismiss: async () => {},
      refresh: async () => {},
      open: id => setOpened(id ?? ''),
      notice,
      dismissNotice: () => setNotice(null),
      registerView: () => {},
    }
    return (
      <RuntimeInteractionsContext.Provider value={value}>
        <div
          className="flex min-h-screen bg-background text-text-primary"
          data-testid="catalog-content-layout"
        >
          <aside
            className="w-60 shrink-0 space-y-1 bg-muted p-3"
            data-testid="catalog-layout-sidebar"
          >
            <DesktopSidebarNavItem
              icon={Plus}
              label="新建任务"
              testId="catalog-layout-new"
              onClick={() => setOpened('new')}
            />
            <DesktopSidebarNavItem
              icon={Bot}
              label="我的助理"
              testId="catalog-layout-assistant"
              badge={<span className="rounded border border-border px-1 text-xs">Beta</span>}
              onClick={() => setOpened('assistant')}
            />
            <DesktopSidebarNavItem
              icon={CalendarClock}
              label="已安排"
              testId="catalog-layout-scheduled"
              onClick={() => setOpened('scheduled')}
            />
            <DesktopSidebarSectionHeader
              title="项目空间"
              expanded={expanded}
              hasContent
              onToggle={() => setExpanded(previous => !previous)}
              toggleTestId="catalog-layout-section"
              iconTestId="catalog-layout-section-icon"
            >
              {null}
            </DesktopSidebarSectionHeader>
          </aside>
          <main className="min-w-0 flex-1 p-6">
            <p>导航保留左对齐与紧凑行高；通知的标题、时间和问题保持各自的内容布局。</p>
            <output data-testid="catalog-layout-opened">{opened}</output>
          </main>
          <RuntimeInteractionNotice />
        </div>
      </RuntimeInteractionsContext.Provider>
    )
  },
}

export const QuickPhraseActions: Story = {
  render: function Example() {
    const { t } = useTranslation('common')
    const [phrases, setPhrases] = useState(() => defaultQuickPhrases.map(phrase => ({ ...phrase })))
    return (
      <div className="mx-auto max-w-3xl p-6" data-testid="catalog-quick-phrases-layout">
        <QuickPhrasesEditor
          phrases={phrases}
          onChange={setPhrases}
          translate={(key, fallback, options) => t(key, { defaultValue: fallback, ...options })}
          testIdPrefix="catalog-"
        />
      </div>
    )
  },
}
