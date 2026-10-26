// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react'

export interface ProjectSettingsSection {
  content: ReactNode
  group?: { id: string; label: string }
  id: string
  label: string
  testId: string
}

export function ProjectSettingsShell({
  ariaLabel,
  onSectionChange,
  selectedSectionId,
  sections,
  testId = 'project-settings-shell',
}: {
  ariaLabel: string
  onSectionChange?(sectionId: string): void
  selectedSectionId?: string
  sections: ProjectSettingsSection[]
  testId?: string
}) {
  const [internalSelectedId, setInternalSelectedId] = useState(sections[0]?.id ?? '')
  const selectedId = selectedSectionId ?? internalSelectedId
  const selected = sections.find(section => section.id === selectedId) ?? sections[0]

  if (!selected) return null

  const groups = new Map<string, { label: string; sections: ProjectSettingsSection[] }>()
  for (const section of sections) {
    const id = section.group?.id ?? 'settings'
    const group = groups.get(id) ?? {
      label: section.group?.label ?? ariaLabel,
      sections: [],
    }
    group.sections.push(section)
    groups.set(id, group)
  }

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background md:flex-row"
      data-testid={testId}
    >
      <aside className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2 md:block md:w-44 md:space-y-6 md:overflow-y-auto md:border-b-0 md:border-r md:py-5">
        {[...groups].map(([id, group]) => (
          <section key={id} className="shrink-0">
            <h2
              className="sr-only px-2 pb-2 text-xs font-medium text-text-muted md:not-sr-only"
              data-testid={`${testId}-group-${id}`}
            >
              {group.label}
            </h2>
            <nav aria-label={group.label} className="flex gap-1 md:block md:space-y-0.5">
              {group.sections.map(section => (
                <button
                  type="button"
                  aria-current={selected.id === section.id ? 'page' : undefined}
                  className={
                    selected.id === section.id
                      ? 'flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md bg-muted px-3 text-left text-sm font-medium text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus/70 md:min-h-8 md:w-full md:px-2.5'
                      : 'flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-left text-sm text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus/70 md:min-h-8 md:w-full md:px-2.5'
                  }
                  data-testid={section.testId}
                  key={section.id}
                  onClick={() => {
                    setInternalSelectedId(section.id)
                    onSectionChange?.(section.id)
                  }}
                >
                  {section.label}
                </button>
              ))}
            </nav>
          </section>
        ))}
      </aside>
      <main
        className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]"
        data-testid={`${testId}-content`}
      >
        {selected.content}
      </main>
    </div>
  )
}
