import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nearest } from './focus.ts'

const box = (left: number, top: number) => ({
  left,
  top,
  right: left + 10,
  bottom: top + 10,
})

test('nav row: left/right step to the neighbour, nothing past the ends', () => {
  const row = [box(0, 0), box(20, 0), box(40, 0)]
  assert.equal(nearest(row[1], row, 'ArrowRight'), 2)
  assert.equal(nearest(row[1], row, 'ArrowLeft'), 0)
  assert.equal(nearest(row[2], [row[0], row[1]], 'ArrowRight'), -1)
  assert.equal(nearest(row[0], row, 'ArrowUp'), -1)
})

test('grid: down prefers the one straight below over a closer diagonal', () => {
  const from = box(0, 0)
  const below = box(0, 40)
  const diagonal = box(30, 20)
  assert.equal(nearest(from, [diagonal, below], 'ArrowDown'), 1)
})

test('other keys move nothing', () => {
  assert.equal(nearest(box(0, 0), [box(20, 0)], 'Enter'), -1)
})
