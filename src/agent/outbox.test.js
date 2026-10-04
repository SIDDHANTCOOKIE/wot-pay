import { describe, it, expect } from 'vitest'
import { createOutbox } from './outbox.js'
describe('durable ordered outbox', () => {
  it('failed stamp survives restart and blocks success DM until delivered', async () => {
    let saved = [],
      sent = [],
      done = 0,
      fail = true
    const args = {
      persist: (q) => {
        saved = JSON.parse(JSON.stringify(q))
      },
      completed: () => done++,
      deliver: async (x) => {
        if (fail) throw Error('offline')
        sent.push(x.id)
      },
    }
    const first = createOutbox(args)
    await first.add([{ id: 'stamp', completeTrade: true }, { id: 'success-dm' }])
    expect(saved.length).toBe(2)
    expect(done).toBe(0)
    fail = false
    await createOutbox({ ...args, saved }).flush()
    expect(sent).toEqual(['stamp', 'success-dm'])
    expect(done).toBe(1)
    expect(saved).toEqual([])
  })
})
