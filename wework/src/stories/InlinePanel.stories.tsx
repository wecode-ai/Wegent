import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { DialogSurface, InlinePanel, TextField } from '@wegent/collaboration/controls'
import { TemplatePanel } from '../../../packages/collaboration/src/templates/TemplatePanel'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Patterns/InlinePanel', component: InlinePanel } satisfies Meta<
  typeof InlinePanel
>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ pending = false }) {
  const { t } = useTranslation('componentCatalog')
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(false)
  const [value, setValue] = useState('')
  return (
    <>
      <Button data-testid="catalog-inline-owner-open" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
      {open && (
        <DialogSurface
          onClose={() => setOpen(false)}
          render={
            <div
              className="fixed left-1/2 top-1/2 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6"
              aria-label={t('title')}
              data-testid="catalog-inline-owner"
            />
          }
        >
          <div className="space-y-4">
            <Button data-testid="catalog-inline-open" onClick={() => setDetail(true)}>
              {t('details')}
            </Button>
            {detail && (
              <TemplatePanel
                embedded
                title={t('details')}
                closeLabel={t('cancel')}
                busy={pending}
                onClose={() => setDetail(false)}
                description={t('description')}
                footer={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    data-testid="catalog-inline-back"
                    onClick={() => setDetail(false)}
                  >
                    {t('cancel')}
                  </Button>
                }
              >
                <label className="block text-sm">
                  {t('name')}
                  <TextField
                    value={value}
                    onChange={event => setValue(event.target.value)}
                    className="mt-2 w-full"
                    data-testid="catalog-inline-input"
                  />
                </label>
              </TemplatePanel>
            )}
            <Button
              variant="outline"
              data-testid="catalog-inline-owner-close"
              onClick={() => setOpen(false)}
            >
              {t('cancel')}
            </Button>
          </div>
        </DialogSurface>
      )}
    </>
  )
}
export const TemplateInlineStep: Story = { render: () => <Example /> }
export const PendingStep: Story = { render: () => <Example pending /> }
