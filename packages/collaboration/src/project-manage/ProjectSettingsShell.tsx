// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";

export interface ProjectSettingsSection {
  content: ReactNode;
  group?: { id: string; label: string };
  id: string;
  label: string;
  testId: string;
}

export function ProjectSettingsShell({
  ariaLabel,
  onSectionChange,
  selectedSectionId,
  sections,
  testId = "project-settings-shell",
}: {
  ariaLabel: string;
  onSectionChange?(sectionId: string): void;
  selectedSectionId?: string;
  sections: ProjectSettingsSection[];
  testId?: string;
}) {
  const [internalSelectedId, setInternalSelectedId] = useState(
    sections[0]?.id ?? "",
  );
  const selectedId = selectedSectionId ?? internalSelectedId;
  const selected =
    sections.find((section) => section.id === selectedId) ?? sections[0];

  if (!selected) return null;

  const groups = new Map<
    string,
    { label: string; sections: ProjectSettingsSection[] }
  >();
  for (const section of sections) {
    const id = section.group?.id ?? "settings";
    const group = groups.get(id) ?? {
      label: section.group?.label ?? ariaLabel,
      sections: [],
    };
    group.sections.push(section);
    groups.set(id, group);
  }

  return (
    <div
      className="flex h-full min-h-0 flex-1 overflow-hidden bg-background"
      data-testid={testId}
    >
      <aside className="w-48 shrink-0 space-y-6 overflow-y-auto border-r border-border px-3 py-5">
        {[...groups].map(([id, group]) => (
          <section key={id}>
            <h2
              className="px-2 pb-3 text-xs font-medium text-text-muted"
              data-testid={`${testId}-group-${id}`}
            >
              {group.label}
            </h2>
            <nav aria-label={group.label} className="space-y-0.5">
              {group.sections.map((section) => (
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
  );
}
