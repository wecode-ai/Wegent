requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.dataset.animationReady = 'true'
  })
})
