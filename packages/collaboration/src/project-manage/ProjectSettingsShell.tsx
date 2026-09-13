// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";

export interface ProjectSettingsSection {
  content: ReactNode;
  id: string;
  label: string;
  testId: string;
}

export function ProjectSettingsShell({
  ariaLabel,
  onSectionChange,
  selectedSectionId,
  sections,
}: {
  ariaLabel: string;
  onSectionChange?(sectionId: string): void;
  selectedSectionId?: string;
  sections: ProjectSettingsSection[];
}) {
  const [internalSelectedId, setInternalSelectedId] = useState(
    sections[0]?.id ?? "",
  );
  const selectedId = selectedSectionId ?? internalSelectedId;
  const selected =
    sections.find((section) => section.id === selectedId) ?? sections[0];

  if (!selected) return null;

  return (
    <div
      className="flex h-full min-h-0 flex-1 bg-background"
      data-testid="project-settings-shell"
    >
      <aside className="w-48 shrink-0 border-r border-border px-3 py-5">
        <div className="px-2 pb-3 text-xs font-medium text-text-muted">
          {ariaLabel}
        </div>
        <nav aria-label={ariaLabel} className="space-y-0.5">
          {sections.map((section) => (
            <button
              type="button"
              aria-current={selected.id === section.id ? "page" : undefined}
              className={
                selected.id === section.id
                  ? "flex h-8 w-full items-center rounded-lg bg-muted px-2.5 text-left text-sm font-medium text-text-primary"
                  : "flex h-8 w-full items-center rounded-lg px-2.5 text-left text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
              }
              data-testid={section.testId}
              key={section.id}
              onClick={() => {
                setInternalSelectedId(section.id);
                onSectionChange?.(section.id);
              }}
            >
              {section.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">{selected.content}</main>
    </div>
  );
}
