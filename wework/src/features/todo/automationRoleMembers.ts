import { createContext } from 'react'
import type { CloudProjectMember } from '@/api/deliveries'

export const AutomationRoleMembers = createContext<CloudProjectMember[]>([])
