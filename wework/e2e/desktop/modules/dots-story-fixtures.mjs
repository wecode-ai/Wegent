import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ORDERS_V1 =
  'order_id,customer,amount_cents,status\nO1,Aster,10000,paid\nO2,Birch,20000,paid\nO3,Aster,5000,pending\n'
export const ORDERS_V2 =
  'order_id,customer,amount_cents,status\nO1,Aster,10000,paid\nO2,Birch,20000,refunded\nO3,Aster,5000,pending\nO4,Cedar,30000,pending\n'
export const LAUNCH_ANSWER = 'Keep November 20, beta users only'
export const REVENUE_ANSWER = 'Prioritize Cedar; prepare an internal checklist only'
export const LAUNCH_QUESTION =
  'Scope v2 omits the date: keep November 20 for beta users, or postpone beta to November 27?'
export const REVENUE_QUESTION =
  'Paid revenue fell 20000 cents. Prioritize Cedar O4 pending 30000, or investigate Birch O2 refund 20000 first?'

const cartSource =
  'export const totalCents = items => items.reduce((total, item) => total + item.unitPriceCents, 0)\n'

export function comparableDotsPath(value) {
  const path = value.replaceAll('\\', '/')
  const readable = path.startsWith('//?/UNC/')
    ? `//${path.slice(8)}`
    : path.startsWith('//?/')
      ? path.slice(4)
      : path
  return readable.replace(/^[A-Z]:/, drive => drive.toLowerCase())
}
const cartTests =
  "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { totalCents } from './cart.mjs'\ntest('empty cart',()=>assert.equal(totalCents([]),0))\ntest('single item',()=>assert.equal(totalCents([{unitPriceCents:500,quantity:1}]),500))\n"
const quantityTest =
  "test('quantities contribute to total',()=>assert.equal(totalCents([{unitPriceCents:1200,quantity:2},{unitPriceCents:500,quantity:1}]),2900))\n"
const zeroTest =
  "test('zero quantity contributes zero',()=>assert.equal(totalCents([{unitPriceCents:1200,quantity:0}]),0))\n"
const staleAnnouncement =
  'General availability on 2026-11-20: CSV export and automatic scheduling.\n'

export async function prepareDotsFixtures(root) {
  for (const directory of ['cart-fixture', 'launch-fixture', 'revenue-fixture'])
    await mkdir(join(root, directory), { recursive: true })
  const entries = {
    'cart-fixture/cart.mjs': cartSource,
    'cart-fixture/cart.test.mjs': cartTests,
    'cart-fixture/feedback.md':
      'Two units at 1200 cents plus one at 500 cents show 1700 instead of 2900.\n',
    'launch-fixture/scope-v1.md':
      'CSV export and automatic scheduling. General availability: 2026-11-20.\n',
    'launch-fixture/scope-v2.md':
      'CSV export only. Automatic scheduling deferred. Beta users only. Date not specified.\n',
    'launch-fixture/announcement.md': staleAnnouncement,
    'launch-fixture/launch-checklist.md': staleAnnouncement,
    'revenue-fixture/orders-v1.csv': ORDERS_V1,
    'revenue-fixture/orders.csv': ORDERS_V1,
    'revenue-fixture/revenue-report.md': 'Paid 30000 cents; pending 5000 cents.\n',
    'revenue-fixture/followup-plan.md': '',
  }
  for (const [path, content] of Object.entries(entries)) await writeFile(join(root, path), content)
  const cart = join(root, 'cart-fixture')
  const git = args => execFileSync('git', args, { cwd: cart, encoding: 'utf8' })
  git(['init'])
  git(['add', 'cart.mjs', 'cart.test.mjs', 'feedback.md'])
  git([
    '-c',
    'user.name=Dots QA',
    '-c',
    'user.email=dots@example.invalid',
    'commit',
    '-m',
    'test: establish cart baseline',
  ])
}

const prelude = `const fs=require('fs'),p=require('path'),cp=require('child_process'),assert=require('assert/strict');`
const checkedTests = `const tested=cp.spawnSync(process.execPath,['--test','--test-reporter=tap','cart.test.mjs'],{cwd:dir,encoding:'utf8'});assert.equal(tested.status,0,tested.stdout+tested.stderr);fs.writeFileSync(p.join(dir,'passed-tests.txt'),tested.stdout);`
const declare = name =>
  String.raw`const artifact=p.join(dir,${JSON.stringify(name)});const declared=cp.spawnSync(process.env.WEGENT_EXECUTOR_BINARY,['artifact','declare','--path',artifact],{encoding:'utf8'});assert.equal(declared.status,0,declared.stdout+declared.stderr);const line=declared.stdout.split(/\r?\n/).find(value=>value.startsWith('[WEGENT_ARTIFACT]'));assert.ok(line,'The real declaration must return artifact metadata');const metadata=JSON.parse(line.slice('[WEGENT_ARTIFACT]'.length));const comparePath=${comparableDotsPath.toString()};assert.equal(comparePath(metadata.local_path),comparePath(fs.realpathSync(artifact)));assert.equal(metadata.name,p.basename(artifact));assert.equal(metadata.file_size,fs.statSync(artifact).size);assert.match(metadata.sha256,/^[a-f0-9]{64}$/);console.log(declared.stdout);`

export function cartProgram(root, phase) {
  const setup = `${prelude}const dir=${JSON.stringify(join(root, 'cart-fixture'))};`
  if (phase === 1)
    return `${setup}assert.match(fs.readFileSync(p.join(dir,'feedback.md'),'utf8'),/1700 instead of 2900/);fs.appendFileSync(p.join(dir,'cart.test.mjs'),${JSON.stringify(quantityTest)});const before=cp.spawnSync(process.execPath,['--test','--test-reporter=tap','cart.test.mjs'],{cwd:dir,encoding:'utf8'});assert.equal(before.status,1,before.stdout+before.stderr);assert.match(before.stdout,/1700/);assert.match(before.stdout,/2900/);fs.writeFileSync(p.join(dir,'reproduced-failure.txt'),before.stdout+before.stderr);fs.writeFileSync(p.join(dir,'cart.mjs'),${JSON.stringify(cartSource.replace('item.unitPriceCents,', 'item.unitPriceCents * item.quantity,'))});${checkedTests}fs.writeFileSync(p.join(dir,'cart-review.md'),${JSON.stringify('Quantity was ignored. Regression failed with 1700 instead of 2900 before the fix and passes after it.\nChanged cart.mjs and cart.test.mjs.\n')});${declare('cart-review.md')}console.log('DOTS_CART_V1_VERIFIED');`
  return `${setup}fs.appendFileSync(p.join(dir,'cart.test.mjs'),${JSON.stringify(zeroTest)});${checkedTests}fs.appendFileSync(p.join(dir,'cart-review.md'),${JSON.stringify('Zero quantity regression also passes.\n')});${declare('cart-review.md')}console.log('DOTS_CART_V2_VERIFIED');`
}

export function launchReadProgram(root) {
  return `${prelude}const dir=${JSON.stringify(join(root, 'launch-fixture'))};for(const file of ['scope-v1.md','scope-v2.md'])console.log(file+': '+fs.readFileSync(p.join(dir,file),'utf8'));console.log('DOTS_LAUNCH_SOURCES_READ');`
}

export function launchProgram(root, phase) {
  const announcement =
    'CSV export beta for beta users only on 2026-11-20. Automatic scheduling is deferred.\n' +
    (phase === 2 ? 'No automatic scheduling in this beta.\n' : '')
  const checklist =
    '- 2026-11-20: beta users only\n- Verify CSV export\n- Automatic scheduling deferred\n- Internal review only; no external publication\n'
  const summary =
    'scope-v1.md promised general availability and scheduling; scope-v2.md limits delivery to CSV export beta.\nOwner decision: Keep November 20, beta users only. Automatic scheduling deferred.\n'
  return `${prelude}const dir=${JSON.stringify(join(root, 'launch-fixture'))};assert.match(fs.readFileSync(p.join(dir,'scope-v2.md'),'utf8'),/Date not specified/);fs.writeFileSync(p.join(dir,'announcement.md'),${JSON.stringify(announcement)});fs.writeFileSync(p.join(dir,'launch-checklist.md'),${JSON.stringify(checklist)});fs.writeFileSync(p.join(dir,'scope-change-summary.md'),${JSON.stringify(summary)});${declare('announcement.md')}console.log('DOTS_LAUNCH_V${phase}_VERIFIED');`
}

const analysisScript = String.raw`import fs from 'node:fs'
import assert from 'node:assert/strict'
function readTotals(name) {
 const lines=fs.readFileSync(new URL(name,import.meta.url),'utf8').trim().split(/\r?\n/)
 assert.equal(lines.shift(),'order_id,customer,amount_cents,status')
 const totals={paid:0,refunded:0,pending:0,total:0}
 const ids=new Set()
 for(const line of lines){
  const [id,customer,amount,status]=line.split(',')
  assert.ok(id && customer && !ids.has(id),'Invalid or duplicate order')
  ids.add(id)
  assert.match(amount,/^\d+$/,'Invalid amount: '+amount)
  assert.ok(['paid','refunded','pending'].includes(status),'Invalid status')
  const cents=Number(amount)
  assert.ok(Number.isSafeInteger(cents),'Invalid amount range')
  totals[status]+=cents;totals.total+=cents
 }
 return totals
}
const baseline=readTotals('orders-v1.csv')
const totals=readTotals('orders.csv')
assert.ok(baseline.paid>0,'Baseline paid revenue must be positive')
const decline=baseline.paid-totals.paid
const report='# Revenue report\n'+Object.entries(totals).map(([key,value])=>key+': '+value+' cents').join('\n')+'\nPaid decline: '+decline+' cents ('+(decline/baseline.paid*100).toFixed(2)+'%)\nSource: orders.csv; baseline: orders-v1.csv\n'
fs.writeFileSync(new URL('revenue-report.md',import.meta.url),report)
console.log(JSON.stringify(totals))
`

export function revenueProgram(root, phase) {
  const setup = `${prelude}const dir=${JSON.stringify(join(root, 'revenue-fixture'))};`
  if (phase === 3)
    return `${setup}const before=fs.readFileSync(p.join(dir,'revenue-report.md'),'utf8');const result=cp.spawnSync(process.execPath,['analyze.mjs'],{cwd:dir,encoding:'utf8'});assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/Invalid amount: not-a-number/);assert.equal(fs.readFileSync(p.join(dir,'revenue-report.md'),'utf8'),before);console.log('DOTS_REVENUE_INVALID_AMOUNT: '+result.stderr);`
  if (phase === 1)
    return `${setup}fs.writeFileSync(p.join(dir,'analyze.mjs'),${JSON.stringify(analysisScript)});const result=cp.spawnSync(process.execPath,['analyze.mjs'],{cwd:dir,encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(JSON.parse(result.stdout),{paid:30000,refunded:0,pending:5000,total:35000});${declare('revenue-report.md')}console.log('DOTS_REVENUE_V1_VERIFIED');`
  return `${setup}const result=cp.spawnSync(process.execPath,['analyze.mjs'],{cwd:dir,encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(JSON.parse(result.stdout),{paid:10000,refunded:20000,pending:35000,total:65000});${declare('revenue-report.md')}console.log('DOTS_REVENUE_V${phase}_VERIFIED');`
}

export function followupProgram(root) {
  const plan =
    '1. Review Cedar order O4: 30000 cents pending.\n2. Prepare internal collection checklist.\n3. Investigate Birch order O2 refund after Cedar.\nInternal draft only. No customer has been contacted.\n'
  return `${prelude}const dir=${JSON.stringify(join(root, 'revenue-fixture'))};const csv=fs.readFileSync(p.join(dir,'orders.csv'),'utf8');assert.ok(csv.includes('O4,Cedar,30000,pending'));fs.writeFileSync(p.join(dir,'followup-plan.md'),${JSON.stringify(plan)});${declare('followup-plan.md')}console.log('DOTS_REVENUE_DECISION_IMPLEMENTED');`
}

export async function assertLaunchUnchanged(root) {
  for (const name of ['announcement.md', 'launch-checklist.md'])
    assert.equal(await readFile(join(root, 'launch-fixture', name), 'utf8'), staleAnnouncement)
}
