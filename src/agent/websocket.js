// Node's built-in WebSocket fires onerror again when close() is called from
// inside onerror, and nostr-tools does exactly that when a relay is down.
// That loops until the stack overflows and kills the process. Guard close().
import { useWebSocketImplementation } from 'nostr-tools/pool'

class SafeWebSocket extends WebSocket {
  close(...args) {
    if (this._closing) return
    this._closing = true
    try {
      super.close(...args)
    } catch {}
  }
}

useWebSocketImplementation(SafeWebSocket)
