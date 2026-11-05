// Validate source assets without building the Backend or connecting to MySQL.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const root = new URL('../migrations/', import.meta.url)
const files = readdirSync(new URL('revisions/', root)).filter(file => file.endsWith('.json'))
const revisions = files.map(file => {
  const revision = JSON.parse(readFileSync(new URL(`revisions/${file}`, root), 'utf8'))
  assert.equal(file, `${revision.revision}.json`)
  assert.ok(!/%s|__\[POSTCOMPILE_/.test(JSON.stringify(revision)), `Unbound SQLAlchemy parameters in ${file}`)
  return revision
})
const index = new Map(revisions.map(revision => [revision.revision, revision]))
assert.equal(index.size, revisions.length, 'Duplicate revision')
const parents = new Set(revisions.flatMap(revision => revision.parents))
for (const parent of parents) assert.ok(index.has(parent), `Missing parent ${parent}`)
const heads = revisions.filter(revision => !parents.has(revision.revision))
assert.equal(heads.length, 1, 'Expected one latest revision')
const schema = JSON.parse(readFileSync(new URL('schema.json', root), 'utf8'))
assert.equal(schema.revision, heads[0].revision, 'Update the latest schema together with its revision')
assert.equal(new Set(schema.tables.map(table => table.table)).size, schema.tables.length)
const embedded = readFileSync(new URL('../src/migrations/assets.rs', root), 'utf8')
const embeddedIds = [...embedded.matchAll(/revisions\/([^/]+)\.json/g)].map(match => match[1])
assert.deepEqual(embeddedIds.sort(), [...index.keys()].sort(), 'Embedded migration assets differ from source files')
console.log(`Native MySQL assets: ${revisions.length} revisions, ${schema.tables.length} tables, head ${schema.revision}`)
