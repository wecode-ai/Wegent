http.post(E2E_SYNC_URL + '/signals/' + E2E_CHECKPOINT_READY_SIGNAL, {
  body: '{}',
  headers: {
    'Content-Type': 'application/json',
  },
})
