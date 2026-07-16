import { Folder, FolderGit2, Globe2 } from 'lucide-react'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
import { cn } from '@/lib/utils'
import type { ProjectWithTasks } from '@/types/api'

interface ProjectFolderIconProps {
  project: ProjectWithTasks
  className?: string
  testId?: string
  remote?: boolean
}

export function ProjectFolderIcon({
  project,
  className,
  testId,
  remote = false,
}: ProjectFolderIconProps) {
  const gitProject = isGitWorkspaceProject(project)
  const Icon = gitProject ? FolderGit2 : Folder
  const resolvedTestId =
    testId ??
    (remote
      ? `project-remote-folder-icon-${project.id}`
      : gitProject
        ? `project-git-folder-icon-${project.id}`
        : `project-folder-icon-${project.id}`)

  if (remote) {
    return (
      <span data-testid={resolvedTestId} className={cn('relative inline-flex', className)}>
        <Icon className="h-full w-full" />
        <Globe2 className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-[rgb(var(--color-bg-surface))] stroke-[2.5]" />
      </span>
    )
  }

  return <Icon data-testid={resolvedTestId} className={className} />
}
