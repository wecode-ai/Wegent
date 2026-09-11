import { WorkspaceProjectsHome, type WorkspaceProjectsHomeHost } from '@wegent/collaboration'
import '@wegent/collaboration/styles.css'
import { Check, Cloud, Copy, HardDrive, Plus, Search, Settings2 } from 'lucide-react'
import type { CloudLoopItem, CloudMyWorkItem, CloudProjectMember } from '@/api/deliveries'
import { formatRelativeSidebarTime } from '@/components/layout/runtimeSidebarTime'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { CloudTodoModal } from './CloudTodoModal'
import type { LocatedProjectSpace } from './projectSpaceSelection'

interface CloudProjectsHomeProps {
  projects: LocatedProjectSpace[]
  projectCounts: Record<string, number>
  projectMembers: Record<string, CloudProjectMember[]>
  projectItems: Record<string, CloudLoopItem[]>
  myWork: CloudMyWorkItem[]
  searchQuery: string
  onCreateProject: () => void
  onSelectProject: (project: LocatedProjectSpace) => void
  onManageProject: (project: LocatedProjectSpace) => void
  onSelectItem: (item: CloudMyWorkItem) => void
  onOpenMyWork: () => void
}

const icons = {
  Check,
  Cloud,
  Copy,
  HardDrive,
  Plus,
  Search,
  Settings: Settings2,
}

export function CloudProjectsHome(props: CloudProjectsHomeProps) {
  const { t } = useTranslation('common')
  const host: WorkspaceProjectsHomeHost = {
    icons,
    translate: (key, fallback, options) => t(key, fallback, options),
    copyText: copyTextToClipboard,
    formatRelativeTime: formatRelativeSidebarTime,
    renderTooltip: ({ label, align, children }) => (
      <Tooltip label={label} align={align}>
        {children}
      </Tooltip>
    ),
    renderModal: ({ title, width, onClose, children }) => (
      <CloudTodoModal title={title} width={width} onClose={onClose}>
        {children}
      </CloudTodoModal>
    ),
  }

  return <WorkspaceProjectsHome {...props} host={host} />
}
