import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Project the authored declarations independently of the production catalog
// loader, so full-selection tests detect dropped, duplicated or misplaced rows
// without maintaining another shared checkpoint inventory.
const directory = join(process.argv[2], 'wework/e2e/desktop/catalog')
const entries = readdirSync(directory)
  .filter(name => name.endsWith('.json'))
  .map(name => ({
    id: name.slice(0, -5),
    ...JSON.parse(readFileSync(join(directory, name), 'utf8')),
  }))

function expectedMatrix(lane, count, label) {
  const assigned = entries.filter(entry => entry.ci?.[lane])
  for (const entry of assigned) {
    const { shard, position } = entry.ci[lane]
    assert(Number.isInteger(shard) && shard >= 1 && shard <= count, entry.id)
    assert(Number.isFinite(position), entry.id)
  }
  const include = Array.from({ length: count }, (_, index) => {
    const members = assigned
      .filter(entry => entry.ci[lane].shard === index + 1)
      .sort(
        (left, right) =>
          left.ci[lane].position - right.ci[lane].position || left.id.localeCompare(right.id, 'en')
      )
    assert(members.length > 0, `${lane}-${index + 1}`)
    return {
      id: `${lane}-${index + 1}`,
      name: `${label} / shard ${index + 1}`,
      segments: members.map(entry => entry.id).join(','),
    }
  })
  return JSON.stringify({ include })
}

console.log('wework_desktop_e2e=true')
console.log('wework_desktop_core_e2e=true')
console.log(`wework_desktop_core_e2e_matrix=${expectedMatrix('core', 10, 'Core')}`)
console.log('wework_desktop_cloud_e2e=true')
console.log(`wework_desktop_cloud_e2e_matrix=${expectedMatrix('cloud', 8, 'Cloud')}`)
console.log('wework_desktop_other_e2e=true')
console.log(
  'wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":""}]}'
)
console.log('wework_desktop_macos_inspector_e2e=true')
