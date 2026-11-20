import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { MenuSelect, TimeMenu, WeekdayMenu } from '@/components/library'
import { ActionMenu } from '@/components/common/ActionMenu'

const meta = {
  title: 'Controls/Menus',
  component: MenuSelect,
  parameters: {
    docs: {
      description: {
        component:
          'MenuSelect chooses a value; field renders a labeled outline form field, while toolbar usage stays dense/plain. TimeMenu supplies quarter-hour choices and preserves custom times. WeekdayMenu uses checkboxes for multiple days (at least one) or radios with single; multiple stays open and single closes after selection. ActionMenu executes commands: density dense/compact/default means 28/32/36px on desktop, compact is the default, and every density is at least 44px on mobile. triggerClassName customizes chrome; density owns sizing. / MenuSelect 区分表单与工具栏；TimeMenu 支持自定义时间。星期多选至少保留一项并保持菜单打开，single 单选后关闭。操作菜单密度 dense/compact/default 对应桌面 28/32/36px，默认 compact，移动端统一至少 44px；业务样式只负责外观，尺寸由 density 管理。',
      },
    },
  },
} satisfies Meta<typeof MenuSelect>
export default meta
type Story = StoryObj<Record<string, never>>
function SelectExample({
  disabled = false,
  invalid = false,
}: {
  disabled?: boolean
  invalid?: boolean
}) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('')
  return (
    <div className="space-y-4">
      <MenuSelect
        testId="catalog-select"
        label={t('language')}
        value={value}
        onChange={setValue}
        placeholder={t('choose')}
        options={[
          { value: 'zh-CN', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
        disabled={disabled}
        invalid={invalid && !value}
        field
      />
      <p role="status">
        {t('selected')}: {value || t('empty')}
      </p>
    </div>
  )
}
export const Selection: Story = { render: () => <SelectExample /> }
export const Disabled: Story = { render: () => <SelectExample disabled /> }
export const Validation: Story = { render: () => <SelectExample invalid /> }
export const Commands: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    const [result, setResult] = useState('')
    return (
      <>
        <ActionMenu
          testId="catalog-actions"
          ariaLabel={t('more')}
          triggerLabel={t('more')}
          items={[
            { label: t('copy'), testId: 'catalog-copy', onSelect: () => setResult(t('copy')) },
            {
              label: t('rename'),
              testId: 'catalog-rename',
              children: [
                {
                  label: t('title'),
                  testId: 'catalog-rename-example',
                  onSelect: () => setResult(t('rename')),
                },
              ],
            },
            { label: t('remove'), testId: 'catalog-delete', disabled: true, danger: true },
          ]}
        />
        <p role="status">
          {t('result')}: {result}
        </p>
      </>
    )
  },
}

export const WeekdayScheduling: Story = {
  render: function Example() {
    const { t } = useTranslation('common')
    const [weekdays, setWeekdays] = useState(['1'])
    const [day, setDay] = useState(['1'])
    const [time, setTime] = useState('09:00')
    return (
      <div className="space-y-4">
        <div>
          <p>{t('workbench.project_automation_time', '执行时间')}</p>
          <TimeMenu testId="catalog-schedule-time" value={time} onChange={setTime} />
          <output role="status" data-testid="catalog-schedule-time-result">
            {time}
          </output>
        </div>
        <div>
          <p>{t('workbench.automation_select_days', '选择日期')} · multiple / 多选</p>
          <WeekdayMenu testId="catalog-weekdays" value={weekdays} onChange={setWeekdays} />
          <output role="status" data-testid="catalog-weekdays-result">
            {weekdays.join(',')}
          </output>
        </div>
        <div>
          <p>{t('workbench.automation_select_days', '选择日期')} · single / 单选</p>
          <WeekdayMenu testId="catalog-weekday" value={day} onChange={setDay} single />
          <output role="status" data-testid="catalog-weekday-result">
            {day.join(',')}
          </output>
        </div>
      </div>
    )
  },
}

export const ActionDensities: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    const [result, setResult] = useState('')
    return (
      <div className="flex items-center gap-2">
        {(['dense', 'compact', 'default'] as const).map(density => (
          <ActionMenu
            key={density}
            density={density}
            ariaLabel={t('more') + ' ' + density}
            testId={'catalog-action-' + density}
            items={[{ id: 'copy', label: t('copy'), onSelect: () => setResult(density) }]}
          />
        ))}
        <output role="status">{result}</output>
      </div>
    )
  },
}
