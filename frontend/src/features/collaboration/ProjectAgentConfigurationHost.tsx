// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ChangeEvent } from 'react'
import type { ProjectAgentConfigurationHost } from '@wegent/collaboration'

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

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
          closeButtonProps={{
            'aria-label': closeLabel,
            'data-testid': testIds.close,
            disabled: busy,
          }}
          data-testid={testIds.dialog}
          overlayProps={{ 'data-testid': testIds.backdrop }}
          preventEscapeClose={busy}
          preventOutsideClick={busy}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    )
  },
  renderModePicker({ onChange, options, value }) {
    return (
      <Tabs value={value} onValueChange={nextValue => onChange(nextValue as typeof value)}>
        <TabsList className="grid w-full grid-cols-2">
          {options.map(option => (
            <TabsTrigger data-testid={option.testId} key={option.value} value={option.value}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
