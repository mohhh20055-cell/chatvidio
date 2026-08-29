// Service Worker for ZoomDz platform to handle background operations and native push notifications
const CACHE_NAME = 'zoomdz-cache-v3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event (Network first, never cache /api/ endpoints)
self.addEventListener('fetch', (event) => {
  // Only handle GET requests and skip non-origin requests
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }
  
  // NEVER cache API requests or dynamic proxy routes
  if (event.request.url.includes('/api/')) {
    return; // allow direct browser network fetch
  }
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache static resources only
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// Push Notification Event (Handles server-sent web push payloads)
self.addEventListener('push', (event) => {
  let data = { title: 'منصة ZoomDz التعليمية', body: 'لديك إشعار جديد من المنصة.' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'منصة ZoomDz التعليمية', body: event.data.text() };
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/images/logo-icon.png',
    badge: data.badge || '/images/logo-icon.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/'
    },
    actions: [
      { action: 'open', title: 'فتح المنصة' },
      { action: 'close', title: 'إغلاق' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification Click Event (Directs user to the specific URL when clicked)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  let targetUrl = '/';
  if (event.notification.data && event.notification.data.url) {
    targetUrl = event.notification.data.url;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
