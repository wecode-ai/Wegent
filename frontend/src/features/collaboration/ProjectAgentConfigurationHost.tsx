// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ChangeEvent } from 'react'
import type { ProjectAgentConfigurationHost } from '@wegent/collaboration'
import { Bot, Code2 } from 'lucide-react'

import {
  simpleChoiceCardBaseClass,
  simpleChoiceCardSelectedClass,
  simpleChoiceCardUnselectedClass,
} from '@/components/common/simple-choice-card-styles'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const modeIcons = {
  codex: Code2,
  wegent: Bot,
} as const

export const webProjectAgentConfigurationHost: ProjectAgentConfigurationHost = {
  renderDialog({ busy, children, closeLabel, description, onClose, testIds, title }) {
    return (
      <Dialog
        open
        onOpenChange={open => {
          if (!open && !busy) onClose()
        }}
      >
        <DialogContent
          className="gap-0 overflow-hidden p-0 sm:max-w-[520px]"
          closeButtonProps={{
            'aria-label': closeLabel,
            className: 'right-5 top-5',
            'data-testid': testIds.close,
            disabled: busy,
          }}
          data-testid={testIds.dialog}
          overlayProps={{ 'data-testid': testIds.backdrop }}
          preventEscapeClose={busy}
          preventOutsideClick={busy}
        >
          <DialogHeader className="space-y-1 px-5 pb-4 pr-12 pt-5">
            <DialogTitle className="text-lg leading-6">{title}</DialogTitle>
            <DialogDescription className="text-sm leading-5 text-text-muted">
              {description}
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 pb-5">{children}</div>
        </DialogContent>
      </Dialog>
    )
  },
  renderModePicker({ onChange, options, value }) {
    return (
      <RadioGroup
        className="grid grid-cols-2 gap-2"
        onValueChange={nextValue => onChange(nextValue as typeof value)}
        value={value}
      >
        {options.map(option => {
          const Icon = modeIcons[option.value]
          const selected = option.value === value
          return (
            <label
              className={cn(
                simpleChoiceCardBaseClass,
                selected ? simpleChoiceCardSelectedClass : simpleChoiceCardUnselectedClass
              )}
              data-testid={`${option.testId}-card`}
              key={option.value}
            >
              <RadioGroupItem
                aria-label={option.label}
                data-testid={option.testId}
                value={option.value}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                  <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
                  {option.label}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
                  {option.description}
                </span>
              </span>
            </label>
          )
        })}
      </RadioGroup>
    )
  },
  renderSelect({ ariaLabel, onChange, options, placeholder, testId, value }) {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={ariaLabel} data-testid={testId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  },
  renderTextControl({ ariaLabel, multiline, onChange, placeholder, testId, value }) {
    const props = {
      'aria-label': ariaLabel,
      'data-testid': testId,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value),
      placeholder,
      value,
    }
    return multiline ? <Textarea {...props} /> : <Input {...props} />
  },
  renderPrimaryAction({ children, disabled, onClick, testId }) {
    return (
      <Button
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        type="button"
        variant="primary"
      >
        {children}
      </Button>
    )
  },
}
