import { ArrowUp, Boxes, Mic, Plus, ShieldAlert, Zap } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { DESKTOP_TOP_BAR_BUTTON_CLASS, DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

interface PluginCreateWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
}

export function PluginCreateWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
}: PluginCreateWorkspaceProps) {
  const { t } = useTranslation('common')
  const { projectChat, sendCurrentInput } = useWorkbench()
  const [prompt, setPrompt] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = prompt.trim()
    if (!value || isSubmitting) return

    setIsSubmitting(true)
    projectChat.setSelectedSkills([
      {
        name: 'plugin-creator',
        namespace: 'codex',
        is_public: false,
      },
    ])
    const message = [
      'Use the Codex plugin-creator workflow to create a Codex-compatible plugin for Wegent.',
      'The plugin must use .codex-plugin/plugin.json and should be ready to publish to the Wegent marketplace.',
      '',
      value,
    ].join('\n')

    try {
      const sent = await sendCurrentInput(message)
      if (sent) {
        navigateTo('/')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main
      data-testid="plugin-create-workspace"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <DesktopTopBar
        testId="plugin-create-topbar"
        className={[
          'sticky top-0 z-30 h-12 bg-background/94 pl-20 pr-4 backdrop-blur-xl md:h-[52px] md:pr-7',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
        ].join(' ')}
        left={
          <>
            {topBarLeftActions}
            <button
              type="button"
              className="text-sm font-semibold text-text-muted transition-colors hover:text-text-primary"
              onClick={() => navigateTo('/plugins')}
            >
              {t('workbench.plugins_tab', '插件')}
            </button>
          </>
        }
        right={
          <button
            type="button"
            aria-label={t('workbench.plugins_create', '创建')}
            className={DESKTOP_TOP_BAR_BUTTON_CLASS}
          >
            <Plus />
          </button>
        }
      />

      <section className="mx-auto flex min-h-[calc(100vh-52px)] w-full max-w-[920px] flex-col items-center justify-center px-5 pb-20">
        <h1 className="mb-16 text-center text-[40px] font-medium leading-[48px] tracking-normal text-text-primary">
          {t('workbench.plugins_create_prompt_title', '我们应该在 Wegent 中构建什么？')}
        </h1>

        <form
          onSubmit={submit}
          className="w-full max-w-[760px] overflow-hidden rounded-[22px] border border-border bg-background shadow-[0_22px_70px_rgba(0,0,0,0.10)]"
        >
          <label className="flex min-h-[86px] items-start gap-3 px-6 py-5">
            <Boxes className="mt-1 h-5 w-5 shrink-0 text-primary" />
            <span className="sr-only">
              {t('workbench.plugins_create_prompt_label', '插件需求')}
            </span>
            <textarea
              value={prompt}
              onChange={event => setPrompt(event.target.value)}
              data-testid="plugin-create-prompt-input"
              rows={2}
              placeholder={t('workbench.plugins_create_prompt_placeholder', 'Plugin Creator')}
              className="min-h-[48px] flex-1 resize-none border-0 bg-transparent text-[18px] font-medium leading-7 text-text-primary outline-none placeholder:text-primary"
            />
          </label>
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <div className="flex min-w-0 items-center gap-5 text-[15px] font-medium text-text-muted">
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface"
                aria-label={t('workbench.plugins_create_add_context', '添加上下文')}
              >
                <Plus className="h-5 w-5" />
              </button>
              <span className="flex min-w-0 items-center gap-1.5 text-primary">
                <ShieldAlert className="h-4 w-4" />
                {t('workbench.plugins_create_full_access', '完全访问')}
              </span>
            </div>
            <div className="flex items-center gap-4 text-[15px] font-semibold text-text-primary">
              <span className="hidden items-center gap-1.5 md:flex">
                <Zap className="h-4 w-4 text-text-muted" />
                5.5
                <span className="text-text-muted">
                  {t('workbench.plugins_create_reasoning_high', '超高')}
                </span>
              </span>
              <Mic className="h-5 w-5 text-text-muted" />
              <button
                type="submit"
                disabled={!prompt.trim() || isSubmitting}
                data-testid="plugin-create-submit-button"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-text-primary text-background transition-colors hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={t('workbench.plugins_create_submit', '创建插件')}
              >
                <ArrowUp className="h-5 w-5" />
              </button>
            </div>
          </div>
        </form>
      </section>
    </main>
  )
}
