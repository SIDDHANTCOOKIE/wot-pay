// Network-only: never store keys, tokens, payments or relay responses.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return
  if (new URL(event.request.url).origin !== self.location.origin) return
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f1115"><title>wot-pay · Offline</title>
<style>body{margin:0;background:#0f1115;color:#f4f4f5;font:16px system-ui;min-height:100vh;display:grid;place-items:center}main{max-width:28rem;padding:28px}h1{font-size:32px}p{color:#b3b6bd;line-height:1.6}button{display:inline-block;margin-top:12px;background:#ffa33b;color:#111;padding:14px 22px;border-radius:12px;border:0;cursor:pointer;font-weight:600}</style>
<main><h1>You're offline.</h1><p>Connect to the internet to open the live board. No cached offers or payment details are shown here.</p><form action="/" method="get"><button>Try again</button></form></main></html>`, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })))
})
