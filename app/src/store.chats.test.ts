import { describe, it, expect } from 'vitest'
import { withChatMessage, pruneChats, pruneDms, CHAT_MAX_PER_THREAD, type ChatMessage } from './store'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

const msg = (at: number, action: ChatMessage['action'] = 'on_my_way', from = A): ChatMessage => ({ from, action, at })

describe('withChatMessage', () => {
  it('appends structured signals and keeps delayed delivery in time order', () => {
    expect(withChatMessage(undefined, msg(10))).toEqual([msg(10)])
    const list = withChatMessage([msg(10), msg(30)], msg(20, 'check_in', B))
    expect(list?.map((m) => m.at)).toEqual([10, 20, 30])
  })

  it('drops an exact relay replay but keeps a repeated action at a new time', () => {
    expect(withChatMessage([msg(10)], msg(10))).toBeNull()
    expect(withChatMessage([msg(10)], msg(11))).toHaveLength(2)
  })

  it('caps the signal history, shedding the oldest', () => {
    let list: ChatMessage[] = []
    for (let i = 0; i < CHAT_MAX_PER_THREAD; i++) list = withChatMessage(list, msg(i)) ?? list
    const next = withChatMessage(list, msg(9999, 'check_in'))
    expect(next).toHaveLength(CHAT_MAX_PER_THREAD)
    expect(next?.[0].at).toBe(1)
    expect(next?.at(-1)?.action).toBe('check_in')
  })
})

describe('thread pruning and legacy migration', () => {
  it('keeps only live group/private relationships', () => {
    expect(Object.keys(pruneChats({ c1: [msg(1)], gone: [msg(2)] }, ['c1']))).toEqual(['c1'])
    expect(Object.keys(pruneDms({ [A]: [msg(1)], [B]: [msg(2)] }, [A]))).toEqual([A])
  })

  it('migrates exact old shortcut labels and removes arbitrary stored chat', () => {
    const legacy = {
      c1: [
        { from: A, text: 'On my way', at: 1 },
        { from: A, text: 'meet at the corner', at: 2 },
        { from: A, text: 'https://example.com', at: 3 },
      ],
    }
    expect(pruneChats(legacy, ['c1'])).toEqual({ c1: [msg(1)] })
  })

  it('migrates the fixed exact-location marker but drops malformed entries', () => {
    const legacy = {
      [A]: [
        { from: A, text: '📍 Shared their exact location', at: 1, geohash: 'gcpvj0e', precision: 9 },
        { from: A, text: 'custom DM', at: 2 },
        { nope: true },
      ],
    }
    expect(pruneDms(legacy, [A])).toEqual({
      [A]: [{ from: A, action: 'shared_exact_location', at: 1, geohash: 'gcpvj0e', precision: 9 }],
    })
  })

  it('drops empty threads and handles undefined', () => {
    expect(pruneChats({ c1: [] }, ['c1'])).toEqual({})
    expect(pruneChats(undefined, ['c1'])).toEqual({})
    expect(pruneDms(undefined, [A])).toEqual({})
  })
})
