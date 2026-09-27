// This file is both the page loader and the same-origin isolation service worker.
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', event => {
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
    event.respondWith(fetch(event.request).then(response => {
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
    if (!crossOriginIsolated) {
      if (!isSecureContext || !('serviceWorker' in navigator)) throw Error('HTTPSで開いてください。');
      await navigator.serviceWorker.register(worker, { updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
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
