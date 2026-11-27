import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export interface ResourceDestinationOption {
  id: string
  testId: string
  label: string
  description: string
  icon: ReactNode
  disabled?: boolean
  children?: ResourceDestinationOption[]
  onSelect?(): void
}

export function ResourceDestinationDialog({
  title,
  description,
  closeLabel,
  options,
  onClose,
}: {
  title: string
  description: string
  closeLabel: string
  options: ResourceDestinationOption[]
  onClose(): void
}) {
  const [parentOption, setParentOption] = useState<ResourceDestinationOption | null>(null)
  const activeOptions = parentOption?.children ?? options

  return (
    <div
      className="collaboration-resource-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <DialogSurface
        onClose={() => {
          if (parentOption) setParentOption(null)
          else onClose()
        }}
        render={
          <section
            className="collaboration-resource-dialog"
            aria-label={title}
            data-testid="resource-destination-dialog"
          />
        }
      >
        <header>
          {parentOption ? (
            <ControlButton
              variant="unstyled"
              type="button"
              aria-label={closeLabel}
              data-testid="resource-destination-back"
              onClick={() => setParentOption(null)}
            >
              <ChevronLeft aria-hidden="true" />
            </ControlButton>
          ) : null}
          <div>
            <h2>{parentOption?.label ?? title}</h2>
            <p>{parentOption?.description ?? description}</p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            aria-label={closeLabel}
            data-testid="resource-destination-close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </ControlButton>
        </header>
        <div className="collaboration-resource-create-options">
          {activeOptions.map(option => (
            <ControlButton
              variant="unstyled"
              type="button"
              key={option.id}
              data-testid={option.testId}
              disabled={option.disabled}
              onClick={() => {
                if (option.children?.length) {
                  setParentOption(option)
                  return
                }
                onClose()
                option.onSelect?.()
              }}
            >
              {option.icon}
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </ControlButton>
          ))}
        </div>
      </DialogSurface>
    </div>
  )
}
