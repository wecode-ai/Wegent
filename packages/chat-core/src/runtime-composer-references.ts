import type { LocalDeviceApp, LocalDeviceSkill } from './runtime-composer-catalog'

export function dedupeLocalSkills(input: LocalDeviceSkill[]): LocalDeviceSkill[] {
  const deduped = new Map<string, LocalDeviceSkill>()
  input.forEach(skill => {
    const key = (skill.name || skill.path).trim().toLowerCase()
    const current = deduped.get(key)
    deduped.set(key, current ? preferLocalSkill(current, skill) : skill)
  })
  return Array.from(deduped.values())
}

function preferLocalSkill(left: LocalDeviceSkill, right: LocalDeviceSkill): LocalDeviceSkill {
  const leftRank = skillSourceRank(left)
  const rightRank = skillSourceRank(right)
  if (leftRank !== rightRank) return leftRank < rightRank ? left : right
  return (left.mtime ?? 0) >= (right.mtime ?? 0) ? left : right
}

function skillSourceRank(skill: LocalDeviceSkill): number {
  if (skill.source_priority !== undefined) return skill.source_priority
  if (skill.source === 'codex') return 0
  if (skill.source === 'codex-plugin') return 1
  return 2
}

export function skillReference(skill: LocalDeviceSkill): string {
  return `[$${skill.name}](${skill.path})`
}

export function appReference(app: LocalDeviceApp): string {
  if (app.skillPath) return `[$${app.name || app.id}](${app.skillPath})`
  return `[$${app.name || app.id}](app://${app.id})`
}
