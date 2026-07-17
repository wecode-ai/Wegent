import type { LocalDeviceSkill } from '@/types/api'

export function localSkillReference(
  skill: Pick<LocalDeviceSkill, 'name' | 'path'>,
  mentionName = skill.name
): string {
  return `[$${mentionName}](${skill.path})`
}
