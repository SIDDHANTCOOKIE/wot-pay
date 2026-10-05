// Stable signed payloads survive retry and restart; later actions wait for earlier success.
export function createOutbox({ saved = [], persist, deliver, completed, snapshot = () => null, restore = () => {} }) {
  const queue = [...saved]
  let running = false
  async function flush() {
    if (running) return
    running = true
    try {
      while (queue.length) {
        const item = queue[0]
        try {
          await deliver(item)
        } catch {
          return
        }
        // Persist removal before reporting success. On a disk failure the stable
        // signed item remains retryable rather than silently losing completion.
        const before = snapshot()
        queue.shift()
        try {
          if (item.completeTrade) completed()
          persist(queue)
        } catch (e) {
          queue.unshift(item)
          restore(before)
          throw e
        }
      }
    } finally {
      running = false
    }
  }
  return {
    queue,
    flush,
    add(items) {
      queue.push(...items)
      persist(queue)
      return flush()
    },
  }
}
