import type { ProjectWithTasks } from '@/types/api'

const PROJECT_COLORS = ['#14B8A6', '#6B8AF7', '#D6A34A', '#9B6BE8', '#E879A7']

export function projectColor(project: ProjectWithTasks, index: number): string {
  return project.color || PROJECT_COLORS[index % PROJECT_COLORS.length]
}
