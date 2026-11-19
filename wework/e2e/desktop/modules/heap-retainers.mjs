/** Report strong root paths and shallow sizes, never heap strings or arbitrary property names. */
export function summarizeHeapRetainers(snapshot) {
  const {
    node_fields: nf,
    edge_fields: ef,
    node_types: nt,
    edge_types: et,
  } = snapshot.snapshot.meta
  const nodes = snapshot.nodes
  const edges = snapshot.edges
  const strings = snapshot.strings
  const width = nf.length
  const ew = ef.length
  const count = nodes.length / width
  if (!Number.isSafeInteger(count) || count < 1 || count > 2_000_000)
    throw new Error('Invalid heap node count')
  const field = (fields, key) => {
    const index = fields.indexOf(key)
    if (index < 0) throw new Error('Missing heap schema field')
    return index
  }
  const type = field(nf, 'type'),
    name = field(nf, 'name'),
    size = field(nf, 'self_size')
  const ec = field(nf, 'edge_count'),
    to = field(ef, 'to_node'),
    edgeType = field(ef, 'type')
  const parent = new Int32Array(count).fill(-1)
  const offsets = new Uint32Array(count + 1)
  let offset = 0
  for (let i = 0; i < count; i++) {
    offsets[i] = offset
    const n = nodes[i * width + ec]
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid heap edge count')
    offset += n * ew
  }
  offsets[count] = offset
  if (offset !== edges.length) throw new Error('Incomplete heap edges')
  const queue = new Uint32Array(count)
  let begin = 0,
    end = 1
  parent[0] = 0
  while (begin < end) {
    const source = queue[begin++]
    for (let e = offsets[source]; e < offsets[source + 1]; e += ew) {
      const target = edges[e + to] / width
      if (!Number.isSafeInteger(target) || target < 0 || target >= count)
        throw new Error('Invalid heap edge target')
      if (et[edgeType][edges[e + edgeType]] === 'weak' || parent[target] !== -1) continue
      parent[target] = source
      queue[end++] = target
    }
  }
  const allowed = new Set([
    'Object',
    'Array',
    'Map',
    'Set',
    'Buffer',
    'Console',
    'Socket',
    'IncomingMessage',
    'ServerResponse',
    'WebSocket',
    'NativeImage',
    'system / Context',
  ])
  const describe = i => {
    const kind = nt[type][nodes[i * width + type]]
    if (
      ![
        'hidden',
        'array',
        'string',
        'object',
        'code',
        'closure',
        'regexp',
        'number',
        'native',
        'synthetic',
        'concatenated string',
        'sliced string',
        'symbol',
        'bigint',
        'object shape',
      ].includes(kind)
    )
      throw new Error('Invalid heap node type')
    const nameIndex = nodes[i * width + name]
    if (!Number.isSafeInteger(nameIndex) || typeof strings[nameIndex] !== 'string')
      throw new Error('Invalid heap node name')
    const rawName = strings[nameIndex]
    return { type: kind, label: allowed.has(rawName) ? rawName : kind }
  }
  const categories = new Map()
  const candidates = []
  for (let i = 0; i < count; i++) {
    const bytes = nodes[i * width + size]
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid heap size')
    const kind = describe(i).type
    const group = categories.get(kind) ?? { type: kind, nodes: 0, shallowBytes: 0 }
    group.nodes++
    group.shallowBytes += bytes
    categories.set(kind, group)
    if (parent[i] !== -1 && i !== 0) candidates.push({ index: i, shallowBytes: bytes })
  }
  candidates.sort((a, b) => b.shallowBytes - a.shallowBytes)
  return {
    nodeCount: count,
    strongReachableNodes: end,
    categories: [...categories.values()].sort((a, b) => b.shallowBytes - a.shallowBytes),
    largest: candidates.slice(0, 12).map(({ index, shallowBytes }) => {
      const path = []
      let current = index
      while (true) {
        path.push(describe(current))
        if (current === 0 || path.length === 32) break
        current = parent[current]
      }
      return { shallowBytes, rootReached: current === 0, path: path.reverse() }
    }),
    note: 'Post-failure V8 snapshot; one strong path per object, not dominator retained sizes. Snapshot GC occurs after the original measured failure. Raw strings and property names are never exported.',
  }
}
