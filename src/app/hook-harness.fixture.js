// A minimal hook runtime for tests: enough of React's state, effect, memo and
// ref semantics to drive real hooks without a DOM. The test file mocks 'react'
// to call runtime.current and passes the same runtime here. Never used by the app.
export function makeMount(runtime) {
  function mount(hook, ...args) {
    const slots = [], cleanups = []
    const render = () => {
      let i = 0
      const effects = []
      runtime.current = {
        state(init) {
          const k = i++
          if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init }
          const slot = slots[k]
          return [slot.v, next => { slot.v = typeof next === 'function' ? next(slot.v) : next }]
        },
        effect(fn, deps) {
          const k = i++, previous = slots[k]
          if (previous && deps && deps.every((d, j) => d === previous.deps[j])) return
          previous?.cleanup?.()
          slots[k] = { deps }
          effects.push(() => { const cleanup = fn(); if (typeof cleanup === 'function') { slots[k].cleanup = cleanup; cleanups.push(cleanup) } })
        },
        memo(fn, deps) {
          const k = i++, previous = slots[k]
          if (!previous || deps.some((d, j) => d !== previous.deps[j])) slots[k] = { deps, v: fn() }
          return slots[k].v
        },
        ref(value) { const k = i++; if (!(k in slots)) slots[k] = { current: value }; return slots[k] },
      }
      const api = hook(...args)
      effects.forEach(run => run())
      return api
    }
    render()
    return { api: render, unmount: () => cleanups.forEach(c => c()) }
  }
  return mount
}
