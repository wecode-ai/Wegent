// Pure logic tests must not load the DOM fixtures or plugin UI modules.
if (typeof window !== 'undefined') {
  await import('./setup.dom')
}

export {}
