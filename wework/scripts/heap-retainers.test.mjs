import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeHeapRetainers } from '../e2e/desktop/modules/heap-retainers.mjs'

function heap() {
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'self_size', 'edge_count'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        node_types: [['synthetic', 'array', 'string', 'object']],
        edge_types: [['property', 'weak']],
      },
    },
    strings: ['root', 'Array', 'private-token-value', 'private-property-name'],
    nodes: [0, 0, 0, 2, 1, 1, 64, 1, 2, 2, 8192, 0, 3, 2, 1024, 0],
    edges: [0, 3, 4, 1, 3, 12, 0, 3, 8],
  }
}

test('reports shallow sizes and a strong path without heap strings or property names', () => {
  const summary = summarizeHeapRetainers(heap())
  assert.equal(summary.strongReachableNodes, 3)
  assert.equal(summary.largest[0].shallowBytes, 8192)
  assert.deepEqual(
    summary.largest[0].path.map(x => x.label),
    ['synthetic', 'Array', 'string']
  )
  assert.equal(summary.largest[0].rootReached, true)
  assert.ok(!JSON.stringify(summary).includes('private-'))
})
test('does not claim weakly reachable objects have a strong root path', () => {
  const summary = summarizeHeapRetainers(heap())
  assert.equal(summary.largest.length, 2)
  assert.equal(summary.categories.find(x => x.type === 'object').nodes, 1)
})
test('rejects incomplete or invalid heap graphs', () => {
  const incomplete = heap()
  incomplete.edges.pop()
  assert.throws(() => summarizeHeapRetainers(incomplete), /Incomplete/)
  const invalid = heap()
  invalid.edges[2] = 999
  assert.throws(() => summarizeHeapRetainers(invalid), /Invalid heap edge target/)
})
test('rejects unknown schema types instead of exporting arbitrary labels', () => {
  const invalid = heap()
  invalid.snapshot.meta.node_types[0][2] = 'private-type-value'
  assert.throws(() => summarizeHeapRetainers(invalid), /Invalid heap node type/)
})
