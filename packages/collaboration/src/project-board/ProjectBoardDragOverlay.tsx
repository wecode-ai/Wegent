import type { ReactNode } from 'react'

export function ProjectBoardDragOverlay({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="project-board-drag-overlay"
      className="w-[272px] rotate-1 rounded-xl border border-border bg-background p-3 text-left shadow-lg"
    >
      {children}
    </div>
  )
}
