import type { ButtonProps } from '@expo/ui/swift-ui'
import type { ReactElement } from 'react'

export interface ConversationMenuAction {
  id: string
  title: string
  icon: ButtonProps['systemImage']
  disabled: boolean
  destructive?: boolean
  section: 'conversation' | 'workspace' | 'settings'
}

export interface ConversationMenuNativeProps {
  actions: ConversationMenuAction[]
  children: ReactElement
  colorScheme: 'light' | 'dark'
  disabled: boolean
  onSelect: (id: string) => void
  title: string
  width: number
}
