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
  backVisibility?: 'always' | 'collapsed-parent'
  returnFocusRef?: RefObject<HTMLElement | null>
  scroll?: boolean
}

export interface ExperiencePanesProps {
  panes: readonly ExperiencePane[]
  navigation?: ReactNode
  navigationTitle?: ReactNode
  navigationActions?: ReactNode
  navigationWidth?: number
  mobileNavigation?: ReactNode
  onBack?: (paneId: string) => void
  className?: string
}
