import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

type Phase =
  | 'scope-ready'
  | 'scope-released'
  | 'navigation-requested'
  | 'publish-requested'
  | 'view-rendered'
  | 'leave-requested'
  | 'leave-accepted'

function mode(value: string | null | undefined) {
  return value === 'groups' || value === 'projects' ? value : 'unspecified'
}

/** Record navigation gates without storing routes, account identities or work content. */
export function reportCollaborationNavigation(
  phase: Phase,
  search: string,
  details: {
    allowed?: boolean
    mounted?: boolean
    boundTab?: boolean
    ownedTab?: boolean
    renderedView?: string
  } = {}
) {
  logRuntimeTaskCreateStage(
    'collaboration-navigation',
    {
      phase,
      targetView: mode(new URLSearchParams(search).get('collaborationView')),
      allowed: details.allowed,
      mounted: details.mounted,
      boundTab: details.boundTab,
      ownedTab: details.ownedTab,
      renderedView: mode(details.renderedView),
    },
    'debug'
  )
}
