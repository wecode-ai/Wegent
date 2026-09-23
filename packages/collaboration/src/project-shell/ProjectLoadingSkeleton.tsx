// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export function ProjectLoadingSkeleton({
  label,
  layout = "board",
  testId = "collaboration-loading-skeleton",
}: {
  label: string;
  layout?: "board" | "list";
  testId?: string;
}) {
  return (
    <div
      className="collaboration-loading-skeleton"
      data-testid={testId}
      aria-busy="true"
      aria-label={label}
      role="status"
    >
      <div aria-hidden="true" className="collaboration-loading-skeleton-header">
        <span className="collaboration-skeleton-block collaboration-skeleton-title" />
        <span className="collaboration-skeleton-block collaboration-skeleton-tab" />
        <span className="collaboration-skeleton-block collaboration-skeleton-action" />
      </div>
      <div
        aria-hidden="true"
        className={`collaboration-loading-skeleton-content collaboration-loading-skeleton-${layout}`}
      >
        {Array.from({ length: layout === "board" ? 5 : 4 }, (_, column) => (
          <div className="collaboration-skeleton-column" key={column}>
            <span className="collaboration-skeleton-block collaboration-skeleton-column-title" />
            {Array.from(
              { length: layout === "board" && column % 2 === 0 ? 2 : 1 },
              (_, card) => (
                <div className="collaboration-skeleton-card" key={card}>
                  <span className="collaboration-skeleton-block collaboration-skeleton-card-key" />
                  <span className="collaboration-skeleton-block collaboration-skeleton-card-title" />
                  <span className="collaboration-skeleton-block collaboration-skeleton-card-meta" />
                </div>
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
