// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function GroupSettingsSection({
  name,
  label,
  summary,
  defaultOpen = false,
  children,
}: {
  name: 'members' | 'rules' | 'environment' | 'sharing'
  label: string
  summary: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <section className="collaboration-group-settings-section">
      <h3>
        <button
          type="button"
          id={`${id}-heading`}
          aria-expanded={open}
          aria-controls={`${id}-content`}
          data-testid={`collaboration-group-detail-tab-${name}`}
          onClick={() => setOpen(value => !value)}
        >
          <ChevronDown aria-hidden="true" className={open ? 'expanded' : undefined} />
          <span>{label}</span>
          <small>{summary}</small>
        </button>
      </h3>
      <div id={`${id}-content`} role="region" aria-labelledby={`${id}-heading`} hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  )
}
