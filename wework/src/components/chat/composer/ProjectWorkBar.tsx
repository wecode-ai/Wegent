import {
  ProjectWorkBar as SharedProjectWorkBar,
  type ProjectWorkBarProps,
} from '@wegent/collaboration/controls/ProjectWorkBar'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'

export function ProjectWorkBar({
  extensionContext = {},
  showWorkSection = true,
  ...props
}: Omit<
  ProjectWorkBarProps,
  'translate' | 'isMobile' | 'renderCreateSection' | 'renderWorkSection'
> & { extensionContext?: object; showWorkSection?: boolean }) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  return (
    <SharedProjectWorkBar
      {...props}
      translate={(key, fallback, options) =>
        String(t(key, { ...options, ...(fallback ? { defaultValue: fallback } : {}) }))
      }
      isMobile={isMobile}
      onSelectProjectWorkspace={
        props.onSelectProjectWorkspace
          ? (projectId, workspaceId) => props.onSelectProjectWorkspace?.(projectId, workspaceId)
          : undefined
      }
      renderCreateSection={closeMenu => (
        <DshContributionSlotSurface
          attachedClassName="contents"
          props={{ closeMenu, context: { onCreateProjectMode: props.onCreateProjectMode } }}
          slot={WEWORK_DSH_SLOTS.projectCreateSection}
        />
      )}
      renderWorkSection={project =>
        showWorkSection ? (
          <ProjectWorkSection context={{ ...extensionContext, compact: isMobile, project }} />
        ) : null
      }
    />
  )
}

export function ProjectWorkSection({ context }: { context: object }) {
  return (
    <DshContributionSlotSurface
      attachedClassName="contents"
      props={{ context }}
      slot={WEWORK_DSH_SLOTS.projectWorkSection}
    />
  )
}
