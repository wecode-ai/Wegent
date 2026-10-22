import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { ActionMenu } from '../controls/ActionMenu'
import './issue-save-button.css'

interface IssueSaveButtonProps {
  testId: string
  disabled: boolean
  saving: boolean
  notificationAvailable: boolean
  className?: string
  labels: {
    saveAndNotify: string
    saveWithoutNotification: string
    options: string
  }
  children: ReactNode
  onSave: (notifyAssignee: boolean) => Promise<void>
}

export function IssueSaveButton({
  testId,
  disabled,
  saving,
  notificationAvailable,
  className,
  labels,
  children,
  onSave,
}: IssueSaveButtonProps) {
  const button = (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={() => void onSave(true)}
      className={className}
    >
      {notificationAvailable && !saving ? labels.saveAndNotify : children}
    </button>
  )

  return notificationAvailable ? (
    <span className="issue-save-actions">
      {button}
      <ActionMenu
        testId={`${testId}-options`}
        ariaLabel={labels.options}
        icon={ChevronDown}
        disabled={disabled}
        placement="bottom-end"
        triggerClassName={`${className ?? ''} issue-save-options`}
        itemClassName="min-h-11 md:min-h-8"
        items={[
          {
            testId: `${testId}-without-notification`,
            label: labels.saveWithoutNotification,
            onSelect: () => onSave(false),
          },
        ]}
      />
    </span>
  ) : (
    button
  )
}
