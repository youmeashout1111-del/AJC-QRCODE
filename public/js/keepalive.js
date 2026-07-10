/**
 * keepalive.js — Prevents Render.com free-tier from sleeping
 * Pings /ping every 10 minutes when an admin/moderator is logged in.
 */
(function () {
  const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  let keepAliveTimer = null;

  function ping() {
    fetch('/ping')
      .then(r => r.json())
      .then(data => console.debug('[KeepAlive] Server OK —', data.time))
      .catch(() => console.warn('[KeepAlive] Ping failed — server may be waking up'));
  }

  /** Call this after a successful login to start pinging */
  window.startKeepAlive = function () {
    if (keepAliveTimer) return; // already running
    ping(); // immediate first ping
    keepAliveTimer = setInterval(ping, INTERVAL_MS);
    console.info('[KeepAlive] Started — pinging every 10 min');
  };

  /** Call this on logout */
  window.stopKeepAlive = function () {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      console.info('[KeepAlive] Stopped');
    }
  };
})();
