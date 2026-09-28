// This file is both the page loader and the same-origin isolation service worker.
// Build: __MELONDS_BUILD_ID__
if (typeof window === 'undefined') {
  // Coalesce dispatcher/pthread imports in memory only. Nothing is written to
  // CacheStorage; a new service-worker build starts with an empty runtime map.
  const runtime = new Map();
  function request(request) {
    const url = new URL(request.url);
    const reusable = request.method === 'GET' && url.origin === self.location.origin
      && /\/(main\.js|melonds\.wasm)$/.test(url.pathname);
    if (!reusable) return fetch(request);
    if (request.cache === 'reload' || request.cache === 'no-store') runtime.delete(url.href);
    if (!runtime.has(url.href)) {
      if (runtime.size >= 4) runtime.delete(runtime.keys().next().value);
      const pending = fetch(request).then(async response => {
        if (!response.ok) { runtime.delete(url.href); return response; }
        return new Response(await response.arrayBuffer(), { status: response.status,
          statusText: response.statusText, headers: response.headers });
      }).catch(error => { runtime.delete(url.href); throw error; });
      runtime.set(url.href, pending);
    }
    return runtime.get(url.href).then(response => response.clone());
  }
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('message', event => {
    if (event.data === 'melonds-claim') event.waitUntil(self.clients.claim());
  });
  self.addEventListener('fetch', event => {
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
    event.respondWith(request(event.request).then(response => {
      if (!response.ok || response.type === 'opaque') return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }));
  });
} else {
  const main = new URL('./main.js', document.currentScript.src);
  const worker = new URL('./loader.js', document.currentScript.src);
  (async () => {
    if (isSecureContext && 'serviceWorker' in navigator) {
      await navigator.serviceWorker.register(worker, { updateViaCache: 'none' });
      const registration = await navigator.serviceWorker.ready;
      // A hard reload may deliberately bypass an already active worker.
      // Header-isolated pages can boot immediately instead of waiting forever.
      if (!navigator.serviceWorker.controller) {
        registration.active?.postMessage('melonds-claim');
        if (!crossOriginIsolated) await new Promise((resolve, reject) => {
          const changed = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            navigator.serviceWorker.removeEventListener('controllerchange', changed);
            reject(Error('Service Workerを有効にできません。通常の再読み込みで開き直してください。'));
          }, 5000);
          navigator.serviceWorker.addEventListener('controllerchange', changed, { once: true });
        });
      }
    }
    if (!crossOriginIsolated) {
      if (!isSecureContext || !('serviceWorker' in navigator)) throw Error('HTTPSで開いてください。');

      if (sessionStorage.getItem('melonds-isolation-reload') === location.href) throw Error('SharedArrayBufferを有効にできません。別ウィンドウで開き直してください。');
      sessionStorage.setItem('melonds-isolation-reload', location.href);
      location.reload();
      return;
    }
    sessionStorage.removeItem('melonds-isolation-reload');
    await import(main.href);
  })().catch(error => {
    document.querySelector('#backend-status').textContent = '起動失敗';
    const notice = document.querySelector('#notice');
    notice.textContent = error.message || String(error); notice.hidden = false;
    console.error(error);
  });
}
