import { relative } from 'node:path'
import { BaseSequencer } from 'vitest/node'
import { balanceUnitTests } from '../../.github/scripts/balance-wework-unit-tests.mjs'

export default class CiTestSequencer extends BaseSequencer {
  async shard(files) {
    const { shard, root } = this.ctx.config
    if (!shard) return files
    const paths = files.map(file => relative(root, file.moduleId).replaceAll('\\', '/'))
    const selected = new Set(balanceUnitTests(paths, shard.index, shard.count))
    return files.filter((_, index) => selected.has(paths[index]))
  }
}
