// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, type ComponentType, type ReactNode } from 'react'
import type { ProjectSettingsSection } from './ProjectSettingsShell'

export interface ProjectSettingsPagesProps {
  sections: ProjectSettingsSection[]
  selectedSectionId: string
  testId: string
}

export function ActiveProjectSettingsPages({
  sections,
  selectedSectionId,
  testId,
}: ProjectSettingsPagesProps) {
  const selected = sections.find(section => section.id === selectedSectionId)
  return selected ? (
    <div key={selected.id} className="min-h-0" data-testid={`${testId}-page-${selected.id}`}>
      {selected.content}
    </div>
  ) : null
}

/** The host supplies the lifecycle boundary supported by its React renderer. */
export function RetainedProjectSettingsPages({
  sections,
  selectedSectionId,
  testId,
  boundary: Boundary,
}: ProjectSettingsPagesProps & {
  boundary: ComponentType<{ mode: 'visible' | 'hidden'; children: ReactNode }>
}) {
  const [visited, setVisited] = useState(() => new Set([selectedSectionId]))
  if (!visited.has(selectedSectionId)) setVisited(new Set([...visited, selectedSectionId]))
  return sections
    .filter(section => section.id === selectedSectionId || visited.has(section.id))
    .map(section => (
      <Boundary key={section.id} mode={section.id === selectedSectionId ? 'visible' : 'hidden'}>
        <div className="min-h-0" data-testid={`${testId}-page-${section.id}`}>
          {section.content}
        </div>
      </Boundary>
    ))
}
