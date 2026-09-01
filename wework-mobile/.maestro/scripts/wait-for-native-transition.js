const readyAt = Date.now() + 3000
while (Date.now() < readyAt) {
  // XCTest exposes some native transitions before their controls accept touches.
}
