const portInput = document.getElementById('port')
const saveBtn = document.getElementById('save')
const statusEl = document.getElementById('status')

async function loadSettings() {
  const stored = await chrome.storage.local.get(['relayPort'])
  if (stored.relayPort) {
    portInput.value = stored.relayPort
  }
}

function showStatus(message, isError = false) {
  statusEl.textContent = message
  statusEl.className = 'status ' + (isError ? 'error' : 'success')
  statusEl.style.display = 'block'
  setTimeout(() => {
    statusEl.style.display = 'none'
  }, 3000)
}

saveBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10)
  if (!port || port < 1 || port > 65535) {
    showStatus('Invalid port number', true)
    return
  }

  await chrome.storage.local.set({ relayPort: port })
  showStatus('Settings saved!')
})

loadSettings()
