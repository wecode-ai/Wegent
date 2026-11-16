import assert from 'node:assert/strict'

function overlaps(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  )
}

// Verifies Chromium's native drag-region registration and geometry, not an OS pointer drag.
export function assertStartupSplashDragRegions(snapshot) {
  const regions = snapshot.dragRegions
  assert.ok(regions?.stage, 'The startup animation has no native drag region')
  assert.equal(
    regions.stage.appRegion,
    'drag',
    'The startup stage does not register native dragging'
  )
  assert.ok(regions.stage.bounds.width > 0 && regions.stage.bounds.height > 0)
  assert.ok(regions.status, 'The startup status area was not inspected')
  assert.equal(regions.status.appRegion, 'no-drag', 'The startup status area blocks interaction')
  assert.equal(regions.stage.bounds.x, regions.status.bounds.x)
  assert.equal(regions.stage.bounds.width, regions.status.bounds.width)
  assert.equal(
    regions.stage.bounds.y + regions.stage.bounds.height,
    regions.status.bounds.y,
    'The native drag region does not stop at the status area'
  )
  for (const control of regions.controls) {
    assert.equal(control.appRegion, 'no-drag', `Startup control ${control.id} is not excluded`)
    assert.equal(
      overlaps(regions.stage.bounds, control.bounds),
      false,
      `The native drag region geometrically overlaps startup control ${control.id}`
    )
  }
  return regions
}
