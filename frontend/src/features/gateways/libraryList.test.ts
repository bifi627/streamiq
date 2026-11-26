import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError, httpError } from '../../shared/errors.ts'
import {
  addableFolders,
  canRemoveFolder,
  draftReady,
  emptyDraft,
  folderLabel,
  toggleFolder,
  LIBRARIES_POLL,
  librariesMessage,
  libraryStatus,
  rescanSeen,
  nextLibrariesAsk,
  RESCAN_GRACE,
} from './libraryList.ts'
import type { Library } from '../../generated/jellyfin.ts'

const lib = (scanning: boolean): Library => ({
  id: 'a',
  name: 'Films',
  type: 'movies',
  folders: ['/media/films'],
  offline: true,
  extras: 'off',
  scanning,
  progress: scanning ? 40 : 0,
})

test('polled every ≥ 3 s while a library scans, not once none does', () => {
  assert.ok(LIBRARIES_POLL >= 3_000)
  assert.equal(
    nextLibrariesAsk([lib(false), lib(true)], false, 0, 1e9),
    LIBRARIES_POLL,
  )
  assert.equal(nextLibrariesAsk([lib(false)], false, 0, 1e9), false)
  assert.equal(nextLibrariesAsk(undefined, false, 0, 1e9), false)
  assert.equal(nextLibrariesAsk([lib(true)], true, 0, 1e9), false)
})

test('a Rescan polls until its queued scan can show up', () => {
  const at = 1e9
  assert.equal(
    nextLibrariesAsk([lib(false)], false, at, at + 1),
    LIBRARIES_POLL,
  )
  assert.equal(
    nextLibrariesAsk([lib(false)], false, at, at + RESCAN_GRACE),
    false,
  )
})

test("a gateway too old (404), a BYO Jellyfin (409), Jellyfin's message", () => {
  const p = '/streamiq/libraries'
  assert.equal(
    librariesMessage(httpError('tunnel', 404, p)),
    'Update the gateway to manage libraries here.',
  )
  assert.equal(
    librariesMessage(httpError('tunnel', 409, p)),
    "Libraries are managed in your Jellyfin's Dashboard.",
  )
  assert.equal(
    librariesMessage(
      new AppError('http', 'POST /x: HTTP 404: Item not found.', {
        status: 502,
      }),
    ),
    'Jellyfin: POST /x: HTTP 404: Item not found.',
  )
  assert.doesNotMatch(
    librariesMessage(httpError('tunnel', 502, p)),
    /^Jellyfin:/,
  )
})

test('a row says Scanning, else Rescan queued… from the press until the scan shows', () => {
  assert.equal(libraryStatus(lib(true), 'rescan', true), 'Scanning')
  assert.equal(libraryStatus(lib(false), 'rescan', false), 'Rescan queued…')
  assert.equal(libraryStatus(lib(false), undefined, true), 'Rescan queued…')
  assert.equal(libraryStatus(lib(false), 'online', false), null)
})

test("a Rescan's wait ends when its library scans, not another's", () => {
  const r = { id: 'a', at: 5 }
  assert.deepEqual(rescanSeen(r, [{ ...lib(true), id: 'b' }]), r)
  assert.deepEqual(rescanSeen(r, [lib(true)]), { id: '', at: 0 })
})

test('Add folder offers only the folders a library lacks, labelled with their users', () => {
  const all = [
    { path: '/media/films', libraries: ['Films'] },
    { path: '/media/more', libraries: [] },
  ]
  assert.deepEqual(addableFolders(all, lib(false)), [all[1]])
  assert.equal(folderLabel(all[0]), '/media/films (in Films)')
  assert.equal(folderLabel(all[1]), '/media/more')
})

test('a library keeps its last folder', () => {
  assert.equal(canRemoveFolder(lib(false)), false)
  assert.equal(
    canRemoveFolder({ ...lib(false), folders: ['/media/a', '/media/b'] }),
    true,
  )
})

test('Create needs a name and a folder; a folder toggles', () => {
  assert.equal(draftReady(emptyDraft), false)
  const d = toggleFolder({ ...emptyDraft, name: ' Shows ' }, '/media/a')
  assert.equal(draftReady(d), true)
  assert.equal(draftReady({ ...d, name: '  ' }), false)
  assert.deepEqual(toggleFolder(d, '/media/a').folders, [])
})

test("the gateway's 400 reads as its own message", () => {
  assert.equal(
    librariesMessage(
      new AppError('http', 'Pick at least one folder.', { status: 400 }),
    ),
    'Pick at least one folder.',
  )
})
