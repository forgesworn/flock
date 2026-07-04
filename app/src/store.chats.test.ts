import { describe, it, expect } from 'vitest'
import { withChatMessage, pruneChats, pruneDms, CHAT_MAX_PER_THREAD, type ChatMessage } from './store'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

const msg = (at: number, text = 'hi', from = A): ChatMessage => ({ from, text, at })

describe('withChatMessage', () => {
  it('appends to an empty thread', () => {
    expect(withChatMessage(undefined, msg(10))).toEqual([msg(10)])
  })

  it('keeps messages in time order even when delivery is late', () => {
    const list = withChatMessage([msg(10), msg(30)], msg(20, 'late', B))
    expect(list?.map((m) => m.at)).toEqual([10, 20, 30])
  })

  it('drops a relay replay (identical from+at+text) — returns null, list untouched', () => {
    const cur = [msg(10, 'dinner at eight?')]
    expect(withChatMessage(cur, msg(10, 'dinner at eight?'))).toBeNull()
  })

  it('the same text at a different time is a NEW message, not an echo', () => {
    expect(withChatMessage([msg(10, 'yes')], msg(11, 'yes'))).toHaveLength(2)
  })

  it('caps the thread, shedding the oldest', () => {
    let list: ChatMessage[] = []
    for (let i = 0; i < CHAT_MAX_PER_THREAD; i++) list = withChatMessage(list, msg(i, `m${i}`)) ?? list
    const next = withChatMessage(list, msg(9999, 'newest'))
    expect(next).toHaveLength(CHAT_MAX_PER_THREAD)
    expect(next?.[0].at).toBe(1) // oldest (at=0) shed
    expect(next?.at(-1)?.text).toBe('newest')
  })
})

describe('pruneChats', () => {
  it('keeps only threads whose circle still exists', () => {
    const chats = { c1: [msg(1)], gone: [msg(2)] }
    expect(Object.keys(pruneChats(chats, ['c1']))).toEqual(['c1'])
  })

  it('drops empty threads and handles undefined', () => {
    expect(pruneChats({ c1: [] }, ['c1'])).toEqual({})
    expect(pruneChats(undefined, ['c1'])).toEqual({})
  })
})

describe('pruneDms', () => {
  it('keeps only threads with people still in a circle', () => {
    const dms = { [A]: [msg(1)], [B]: [msg(2)] }
    expect(Object.keys(pruneDms(dms, [A]))).toEqual([A])
  })

  it('handles undefined', () => {
    expect(pruneDms(undefined, [A])).toEqual({})
  })
})
