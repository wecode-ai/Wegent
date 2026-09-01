http.post(E2E_SYNC_URL + '/signals/reconnect-streaming', {
  body: '{}',
  headers: {
    'Content-Type': 'application/json',
  },
})
