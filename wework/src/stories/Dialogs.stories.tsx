import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { DialogForm } from '@/components/common/DialogForm'

const meta = {
  title: 'Patterns/Dialogs',
  component: ConfirmDialog,
  parameters: {
    docs: {
      description: {
        component:
          'ConfirmDialog is controlled: the owner handles pending and errors. TextInputDialog owns its draft and shows rejected submissions. DialogForm preserves native submission and IME composition. / 确认框由调用方管理状态；文本框保留失败草稿；表单保护输入法确认。',
      },
    },
  },
} satisfies Meta<typeof ConfirmDialog>
export default meta
type Story = StoryObj<Record<string, never>>

function ConfirmExample({
  destructive = false,
  pending = false,
}: {
  destructive?: boolean
  pending?: boolean
}) {
  const { t } = useTranslation('componentCatalog')
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState('')
  return (
    <>
      <Button data-testid="catalog-confirm-open" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
      <p role="status">{result}</p>
      <ConfirmDialog
        open={open}
        title={t('title')}
        description={t('description')}
        cancelLabel={t('cancel')}
        confirmLabel={t(pending ? 'pending' : destructive ? 'remove' : 'save')}
        confirmTestId="catalog-confirm"
        destructive={destructive}
        pending={pending}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setResult(t('saved'))
          setOpen(false)
        }}
      />
    </>
  )
}
export const Confirmation: Story = { render: () => <ConfirmExample /> }
export const Destructive: Story = { render: () => <ConfirmExample destructive /> }
export const Pending: Story = { render: () => <ConfirmExample pending /> }

function TextExample() {
  const { t } = useTranslation('componentCatalog')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('Example')
  const [fail, setFail] = useState(false)
  return (
    <div className="space-y-4">
      <label className="flex gap-2">
        <Checkbox
          data-testid="catalog-fail-save"
          checked={fail}
          onCheckedChange={checked => setFail(checked === true)}
        />
        {t('fail')}
      </label>
      <Button data-testid="catalog-text-open" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
      <p role="status">
        {t('name')}: {name}
      </p>
      <TextInputDialog
        open={open}
        title={t('title')}
        label={t('name')}
        description={t('description')}
        initialValue={name}
        confirmLabel={t('save')}
        cancelLabel={t('cancel')}
        inputTestId="catalog-text-input"
        confirmTestId="catalog-text-save"
        onClose={() => setOpen(false)}
        onSubmit={async value => {
          if (fail) throw new Error(t('failed'))
          setName(value)
        }}
      />
    </div>
  )
}
export const TextInput: Story = { render: () => <TextExample /> }
export const NativeForm: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    const [result, setResult] = useState('')
    return (
      <DialogForm
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault()
          setResult(t('saved'))
        }}
      >
        <label className="flex gap-2">
          {t('name')}
          <input
            className="rounded border border-border bg-background px-3"
            data-testid="catalog-form-input"
            required
          />
        </label>
        <Button type="submit" data-testid="catalog-form-submit">
          {t('submit')}
        </Button>
        <p role="status">{result}</p>
      </DialogForm>
    )
  },
}
