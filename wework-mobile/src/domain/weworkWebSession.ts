export function weworkWebSessionScript(accessToken: string, expiresAt: number | null): string {
  const token = JSON.stringify(accessToken)
  const expiry = expiresAt === null ? 'null' : String(expiresAt)
  return `(function () {
  var token = ${token};
  var expiresAt = ${expiry};
  try {
    window.localStorage.setItem('auth_token', token);
    if (expiresAt === null) {
      window.localStorage.removeItem('auth_token_expire');
    } else {
      window.localStorage.setItem('auth_token_expire', String(expiresAt));
    }
    var cookie = 'auth_token=' + encodeURIComponent(token) + '; path=/; SameSite=Lax';
    if (expiresAt !== null) cookie += '; expires=' + new Date(expiresAt).toUTCString();
    document.cookie = cookie;
  } catch (error) {
    // The WebView can still show its own sign-in page when storage is unavailable.
  }
})();
true;`
}
