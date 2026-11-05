import type { LucideIcon } from 'lucide-react'
import { ConnectionSetupHeader } from '@wegent/collaboration/automation'

export function StandInConnectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <ConnectionSetupHeader
      icon={Icon}
      title={title}
      description={description}
      testId="stand-in-connection-header"
    />
  )
}
