self.addEventListener('install', (event) => {
  console.log('Service worker installing...');
  // Add any assets to cache here
});

self.addEventListener('fetch', (event) => {
  console.log('Fetching:', event.request.url);
  // A simple pass-through for network requests
  event.respondWith(fetch(event.request));
});
