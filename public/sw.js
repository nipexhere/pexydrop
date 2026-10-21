// PexyDrop's service worker only receives files shared from other apps (Android
// share sheet). It caches nothing else, so the app always loads fresh.
const shareCache = 'pexydrop-share'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return
  event.respondWith((async () => {
    const form = await event.request.formData()
    await caches.delete(shareCache)
    const cache = await caches.open(shareCache)
    const files = form.getAll('files').filter((file) => typeof file !== 'string')
    await Promise.all(files.map((file, index) => cache.put(`/shared/${index}`, new Response(file, {
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
    }))))
    const text = ['title', 'text', 'url'].map((key) => form.get(key)).filter((value) => typeof value === 'string' && value).join('\n')
    if (text) await cache.put('/shared/text', new Response(text))
    return Response.redirect('/?shared=1', 303)
  })())
})
