// Service worker minimo: solo recibe pushes (avisos de sesion y alertas de riesgo,
// mismo contenido que ya se manda por Telegram) y los muestra como notificacion nativa
// del navegador, aunque la pestaña este cerrada.
self.addEventListener('push', (event) => {
  let payload = { title: '📡 Radar de Trading', body: 'Tenés un aviso nuevo.' };
  try { payload = { ...payload, ...event.data.json() }; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: 'logo.png',
      badge: 'logo.png',
      tag: 'radar-aviso',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existente = clientsArr.find((c) => 'focus' in c);
      if (existente) return existente.focus();
      return self.clients.openWindow('/');
    })
  );
});
