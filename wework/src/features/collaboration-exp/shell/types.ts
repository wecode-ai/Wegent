import type { ReactNode, RefObject } from 'react'

export interface ExperiencePane {
  id: string
  title: ReactNode
  content: ReactNode | ((onBack: () => void) => ReactNode)
  actions?: ReactNode
  header?: ReactNode | null
  desktopOnly?: boolean
  minWidth?: number
  defaultWidth?: number
  onBack?: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  scroll?: boolean
  scrollSelector?: string
}

export interface ExperiencePanesProps {
  panes: readonly ExperiencePane[]
  onBack?: (paneId: string) => void
  className?: string
}
