import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Item } from '../library/items.ts'
import {
  caption,
  photoLibraries,
  screenSize,
  step,
  swipe,
  videoLibraries,
  viewerKey,
} from './gallery.ts'
import { photoChildren } from '../library/jellyfin.ts'

const it = (Id: string, more: Partial<Item> = {}) =>
  ({ Id, Name: Id, Type: 'Photo', ...more }) as Item

test('photo libraries are the homevideos ones; the Library home keeps the rest', () => {
  const views = [
    it('m', { CollectionType: 'movies' }),
    it('p', { CollectionType: 'homevideos' }),
    it('s', { CollectionType: 'tvshows' }),
  ]
  assert.deepEqual(
    photoLibraries(views).map((v) => v.Id),
    ['p'],
  )
  assert.deepEqual(
    videoLibraries(views).map((v) => v.Id),
    ['m', 's'],
  )
  assert.deepEqual(photoLibraries(undefined), [])
})

test('step: previous / next among the loaded photos, more past the last while pages remain', () => {
  const ps = [it('a'), it('b'), it('c')]
  assert.deepEqual(step(ps, 'b', 1, false), { to: 'c' })
  assert.deepEqual(step(ps, 'b', -1, false), { to: 'a' })
  assert.equal(step(ps, 'a', -1, true), null)
  assert.equal(step(ps, 'c', 1, false), null)
  assert.equal(step(ps, 'c', 1, true), 'more')
  assert.equal(step(ps, 'gone', 1, true), null)
})

test('swipe: left is next, right previous; short or vertical is none', () => {
  assert.equal(swipe(-80, 10), 1)
  assert.equal(swipe(80, -10), -1)
  assert.equal(swipe(30, 0), 0)
  assert.equal(swipe(-60, 200), 0)
})

test('the viewer asks for the screen in device pixels', () => {
  assert.deepEqual(screenSize(390, 844, 3), { width: 1170, height: 2532 })
  assert.deepEqual(screenSize(1280, 720, 1.5), { width: 1920, height: 1080 })
})

test('caption is the name, never the Overview (JPEG comments)', () => {
  assert.equal(caption(it('Beach', { Overview: 'Lavc62.1.100' })), 'Beach')
})

test('a folder lists sub-folders first, then photos, no videos', () => {
  const url = photoChildren('f', 50)
  assert.match(url, /recursive=false&includeItemTypes=Photo,PhotoAlbum,Folder&/)
  assert.match(url, /sortBy=IsFolder,SortName&sortOrder=Ascending&/)
  assert.match(url, /startIndex=50&limit=50$/)
})

test('viewer keys: ←/→ step, Escape closes, ↑/↓ stay, the rest pass', () => {
  assert.equal(viewerKey('ArrowLeft'), -1)
  assert.equal(viewerKey('ArrowRight'), 1)
  assert.equal(viewerKey('Escape'), 'close')
  assert.equal(viewerKey('ArrowUp'), 'stay')
  assert.equal(viewerKey('Enter'), null)
})
