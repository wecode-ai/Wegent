import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from '@wegent/collaboration/controls/Field'
import { TextField } from '@wegent/collaboration/controls/TextField'
import { SelectField } from '@wegent/collaboration/controls/SelectField'

const meta = {
  title: 'Controls/Field',
  component: Field,
  parameters: {
    docs: {
      description: {
        component:
          'SDK Field connects controls, labels, descriptions and errors. Full form fields use default density and an outline; settings rows and toolbars keep their own compact layout. / 表单字段统一标签、说明、错误关联，桌面 36px、移动 44px。',
      },
    },
  },
} satisfies Meta<typeof Field>
export default meta
type Story = StoryObj<typeof meta>

function Example({ invalid = false, disabled = false }: { invalid?: boolean; disabled?: boolean }) {
  const [name, setName] = useState('Example')
  const [environment, setEnvironment] = useState('local')
  return (
    <div className="grid max-w-md gap-4">
      <Field invalid={invalid} disabled={disabled}>
        <FieldLabel>Name / 名称</FieldLabel>
        <TextField
          data-testid="catalog-form-name"
          value={name}
          onChange={event => setName(event.target.value)}
          className="w-full"
        />
        <FieldDescription>Choose a recognizable name. / 使用便于识别的名称。</FieldDescription>
        <FieldError>Enter a different name. / 请使用其他名称。</FieldError>
      </Field>
      <Field disabled={disabled}>
        <FieldLabel>Environment / 执行环境</FieldLabel>
        <SelectField
          testId="catalog-form-environment"
          accessibleLabel="Environment / 执行环境"
          value={environment}
          options={[
            { value: 'local', label: 'Local / 本地' },
            { value: 'cloud', label: 'Cloud / 云端' },
          ]}
          onChange={setEnvironment}
          className="w-full"
        />
        <FieldDescription>
          The selection label stays separate from its current value. / 字段名称不随选中值变化。
        </FieldDescription>
      </Field>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Invalid: Story = { render: () => <Example invalid /> }
export const Disabled: Story = { render: () => <Example disabled /> }
