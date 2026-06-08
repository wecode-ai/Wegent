import { Folder, FolderGit2 } from 'lucide-react'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
import type { ProjectWithTasks } from '@/types/api'

interface ProjectFolderIconProps {
  project: ProjectWithTasks
  className?: string
  testId?: string
}

export function ProjectFolderIcon({ project, className, testId }: ProjectFolderIconProps) {
  const gitProject = isGitWorkspaceProject(project)
  const Icon = gitProject ? FolderGit2 : Folder

  return (
    <Icon
      data-testid={
        testId ??
        (gitProject
          ? `project-git-folder-icon-${project.id}`
          : `project-folder-icon-${project.id}`)
      }
      className={className}
    />
  )
}
