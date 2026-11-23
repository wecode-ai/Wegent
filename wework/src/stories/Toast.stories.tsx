import { useCallback, useMemo, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Toast,
  ToastRegion,
  ToastTitle,
  ToastDescription,
  ToastAction,
  ToastClose,
  createToaster,
} from '@wegent/collaboration/controls'
import { Button } from '@/components/ui/button'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/Toast', component: Toast } satisfies Meta<typeof Toast>
export default meta
type Story = StoryObj<Record<string, never>>
function Queue({ error = false, loading = false }) {
  const { t } = useTranslation('componentCatalog')
  const [toaster] = useState(createToaster)
  const [actions, setActions] = useState(0)
  const attachQueue = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) return () => toaster.dismiss()
    },
    [toaster]
  )
  return (
    <div ref={attachQueue} className="space-y-3">
      <Button
        data-testid="catalog-toast-show"
        onClick={() =>
          toaster(t('title'), {
            description: t('description'),
            type: error ? 'error' : loading ? 'loading' : 'success',
            duration: loading ? Infinity : 2200,
            action: { label: t('copy'), onAction: () => setActions(count => count + 1) },
          })
        }
      >
        {t('open')}
      </Button>
      <output>{actions}</output>
      <ToastRegion toaster={toaster} className="fixed bottom-4 right-4 z-system max-w-sm space-y-2">
        {() => (
          <Toast>
            <div className="min-w-0">
              <ToastTitle />
              <ToastDescription className="text-text-secondary" />
            </div>
            <ToastAction className="min-h-11 px-2 underline" data-testid="catalog-toast-action" />
            <ToastClose
              aria-label={t('cancel')}
              className="min-h-11 px-2"
              data-testid="catalog-toast-close"
            >
              ×
            </ToastClose>
          </Toast>
        )}
      </ToastRegion>
    </div>
  )
}
function Notice({ persistent = false }) {
  const { t } = useTranslation('componentCatalog')
  const anchor = useRef<HTMLDivElement>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [cleared, setCleared] = useState(0)
  const [actions, setActions] = useState(0)
  const onClear = useCallback(() => {
    setMessage(null)
    setCleared(count => count + 1)
  }, [])
  const action = useMemo(
    () =>
      persistent
        ? {
            label: t('copy'),
            testId: 'catalog-notice-action',
            pending: false,
            onClick: () => setActions(count => count + 1),
          }
        : undefined,
    [persistent, t]
  )
  return (
    <div
      ref={anchor}
      className="min-h-72 w-full max-w-md rounded-lg border border-border p-4 space-y-4"
      data-testid="catalog-notice-anchor"
    >
      <Button data-testid="catalog-notice-show" onClick={() => setMessage(t('long').repeat(5))}>
        {t('open')}
      </Button>
      <output data-testid="catalog-notice-clear-count">
        {t('dismissed')}: {cleared}
      </output>
      <output data-testid="catalog-notice-action-count">
        {t('result')}: {actions}
      </output>
      <TransientNotice
        message={message}
        onClear={onClear}
        horizontalAnchorRef={anchor}
        action={action}
      />
    </div>
  )
}
export const Success: Story = { render: () => <Queue /> }
export const Error: Story = { render: () => <Queue error /> }
export const Loading: Story = { render: () => <Queue loading /> }
export const AnchoredLongNotice: Story = { render: () => <Notice /> }
export const PersistentActionNotice: Story = { render: () => <Notice persistent /> }
