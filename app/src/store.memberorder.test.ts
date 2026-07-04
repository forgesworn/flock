import { describe, it, expect } from 'vitest'
import { orderedMembers } from './store'

describe('orderedMembers', () => {
  it('no order set → natural order, unchanged', () => {
    expect(orderedMembers(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('applies a full custom order', () => {
    expect(orderedMembers(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  it('a new joiner not yet in the order falls in after it', () => {
    expect(orderedMembers(['a', 'b', 'c'], ['b', 'a'])).toEqual(['b', 'a', 'c'])
  })

  it('someone who left drops out of the order, nothing else shifts oddly', () => {
    expect(orderedMembers(['a', 'c'], ['c', 'b', 'a'])).toEqual(['c', 'a'])
  })

  it('an empty order array behaves like no order', () => {
    expect(orderedMembers(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})
