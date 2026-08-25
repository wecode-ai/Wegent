const stages = [
  {
    en: 'Opening your projects',
    zh: '正在整理项目',
    paths: [
      [2, 7, 9, 7, 11, 9, 22, 9, 22, 20, 2, 20, 2, 7],
      [4, 12, 20, 12, 20, 12],
      [12, 16, 12, 16],
    ],
  },
  {
    en: 'Connecting your tools',
    zh: '正在连接工具',
    paths: [
      [2, 4, 22, 4, 22, 20, 2, 20, 2, 4, 2, 4, 2, 4],
      [7, 9, 10, 12, 7, 15],
      [13, 15, 18, 15],
    ],
  },
  {
    en: 'Waking your agents',
    zh: '正在唤醒智能体',
    paths: [
      [13, 2, 5, 13, 11, 13, 9, 22, 20, 9, 14, 9, 13, 2],
      [12, 12, 12, 12, 12, 12],
      [12, 12, 12, 12],
    ],
  },
]

const pathElements = [
  document.querySelector('#morph-primary'),
  document.querySelector('#morph-secondary'),
  document.querySelector('#morph-tertiary'),
]
const splashRoot = document.querySelector('#splash-root')
const stageIndicator = document.querySelector('#stage-indicator')
const statusElement = document.querySelector('#splash-status')
const titleElement = document.querySelector('#splash-title')
const stageDots = [...document.querySelectorAll('.stage-dot')]
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const isChinese = navigator.language.toLowerCase().startsWith('zh')
const currentPaths = stages[0].paths.map(path => [...path])
const velocities = stages[0].paths.map(path => path.map(() => 0))
let stageIndex = prefersReducedMotion ? stages.length - 1 : 0
let previousTime = performance.now()

function pathData(points) {
  let data = `M${points[0]} ${points[1]}`
  for (let index = 2; index < points.length; index += 2) {
    data += `L${points[index]} ${points[index + 1]}`
  }
  return data
}

function paintPaths(paths) {
  paths.forEach((path, index) => {
    pathElements[index]?.setAttribute('d', pathData(path))
  })
}

function updateCopy(index, animate) {
  const stage = stages[index]
  document.documentElement.lang = isChinese ? 'zh-CN' : 'en'
  document.body.dataset.stage = String(index)
  titleElement.textContent = isChinese ? '我们正在准备工作台' : "We're preparing your workbench"
  splashRoot.setAttribute('aria-label', isChinese ? 'Wework 正在启动' : 'Wework is starting')
  stageIndicator.setAttribute(
    'aria-label',
    isChinese ? '正在准备工作台' : 'Preparing your workbench'
  )
  stageIndicator.setAttribute('aria-valuenow', String(index + 1))

  const replaceStatus = () => {
    statusElement.textContent = isChinese ? stage.zh : stage.en
    statusElement.classList.remove('is-changing')
  }

  if (animate) {
    statusElement.classList.add('is-changing')
    window.setTimeout(replaceStatus, 140)
  } else {
    replaceStatus()
  }

  stageDots.forEach((dot, dotIndex) => {
    dot.classList.toggle('is-active', dotIndex === index)
  })
}

function animateMorph(time) {
  const delta = Math.min((time - previousTime) / 1000, 0.032)
  const targetPaths = stages[stageIndex].paths
  previousTime = time

  currentPaths.forEach((path, pathIndex) => {
    path.forEach((value, coordinateIndex) => {
      const displacement = targetPaths[pathIndex][coordinateIndex] - value
      const acceleration = displacement * 190
      const damping = Math.exp(-24 * delta)
      velocities[pathIndex][coordinateIndex] =
        (velocities[pathIndex][coordinateIndex] + acceleration * delta) * damping
      path[coordinateIndex] += velocities[pathIndex][coordinateIndex] * delta
    })
  })

  paintPaths(currentPaths)
  requestAnimationFrame(animateMorph)
}

if (prefersReducedMotion) {
  currentPaths.forEach((path, pathIndex) => {
    path.splice(0, path.length, ...stages[stageIndex].paths[pathIndex])
  })
  paintPaths(currentPaths)
  updateCopy(stageIndex, false)
} else {
  paintPaths(currentPaths)
  updateCopy(stageIndex, false)
  requestAnimationFrame(animateMorph)
  window.setInterval(() => {
    stageIndex = (stageIndex + 1) % stages.length
    updateCopy(stageIndex, true)
  }, 1150)
}

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.dataset.animationReady = 'true'
  })
})
