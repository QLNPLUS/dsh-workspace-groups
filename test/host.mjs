/**
 * Host-half test — NOT shipped with the bundle.
 *
 * Exercises the two JSON routes `plugin/index.mjs` registers, against real
 * temporary `DSH_HOME` directories, faked at exactly the one seam the Host half
 * needs: `ctx.inject(['connection'])`. Everything below the route is the shipped
 * code path — state-file reads and writes, normalization, every mutation action,
 * persistence, corruption recovery, and malformed-request rejection.
 *
 * Usage: node test/host.mjs
 */

import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const moduleUrl = `file:///${join(here, '..', 'plugin', 'index.mjs').split('\\').join('/')}`

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const mod = await import(moduleUrl)

/**
 * Mount the plugin against a fresh home and a fake Connection registrar.
 * @param home - `DSH_HOME` for this mount.
 * @param config - plugin row config.
 * @returns the recorded routes and a caller for them.
 */
const mount = (home, config = { enabled: true, previewSessions: 2, searchLimit: 80 }) => {
  process.env.DSH_HOME = home
  const routes = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (...values) => warnings.push(values.join(' ')) },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(_services, callback) {
      callback({
        connection: {
          fetch: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        },
        effect: (fn) => fn(),
      })
    },
  }
  mod.apply(ctx, config)
  /** Call one route the way the browser half does. */
  const call = async (path, body) => {
    const route = routes.get(path)
    const request = new Request(`http://dsh.test${path}`, {
      method: route.methods[0],
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { 'content-type': 'application/json' },
    })
    const response = await route.fetch(request)
    const payload = await response.json().catch(() => ({ error: 'unreadable' }))
    return { status: response.status, headers: response.headers, payload }
  }
  return { routes, call, warnings, home }
}

const freshHome = () => mkdtempSync(join(tmpdir(), 'dsh-wg-host-'))

// ═══════════════════════════════════════════════════════════════════════
// Activation and the first read
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ activation')
const primary = mount(freshHome())
check('host exports a name', mod.name === 'dsh-workspace-groups', String(mod.name))
check('registers the two routes', primary.routes.has(mod.STATE_PATH) && primary.routes.has(mod.MUTATE_PATH),
  [...primary.routes.keys()].join(', '))
check('the state route answers GET', primary.routes.get(mod.STATE_PATH).methods.includes('GET'))
check('the mutate route answers POST', primary.routes.get(mod.MUTATE_PATH).methods.includes('POST'))
check('the mutate route buffers its body', primary.routes.get(mod.MUTATE_PATH).requestBody === 'buffered')

console.log('▸ reading the document')
let state = await primary.call(mod.STATE_PATH)
check('first read succeeds', state.status === 200, String(state.status))
check('the answered document is complete', state.payload.version === 1
  && Array.isArray(state.payload.groups) && Array.isArray(state.payload.archivedGroups)
  && typeof state.payload.assign === 'object' && typeof state.payload.orders === 'object'
  && typeof state.payload.workspaceState === 'object' && state.payload.ui.view === 'grouped')
check('config reaches the browser half as settings', state.payload.settings.previewSessions === 2
  && state.payload.settings.searchLimit === 80)
check('the answer is not cacheable', state.headers.get('cache-control') === 'no-store')
check('the document names its own file', typeof state.payload.file === 'string'
  && state.payload.file.endsWith('state.json'), state.payload.file)
check('a fresh home has no errors', state.payload.error === null, String(state.payload.error))

// ═══════════════════════════════════════════════════════════════════════
// Groups
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ groups')
let next = await primary.call(mod.MUTATE_PATH, {
  action: 'createGroup', payload: { name: '客户端项目', color: 'blue', icon: 'code' },
})
check('createGroup adds one group', next.payload.groups.length === 1, String(next.payload.groups.length))
const first = next.payload.groups[0]
check('the group carries the requested name, color and icon',
  first.name === '客户端项目' && first.color === 'blue' && first.icon === 'code', JSON.stringify(first))
check('a new group is unpinned and expanded', first.pinned === false && first.collapsed === false)
check('the group gets a stable id', typeof first.id === 'string' && first.id.length > 0, String(first.id))
const gid = first.id

next = await primary.call(mod.MUTATE_PATH, { action: 'createGroup', payload: { name: '学习', color: 'green', icon: 'book' } })
const gid2 = next.payload.groups.find(group => group.name === '学习')?.id
check('a second group coexists', next.payload.groups.length === 2 && typeof gid2 === 'string')
check('group ids are distinct', gid !== gid2)

next = await primary.call(mod.MUTATE_PATH, {
  action: 'updateGroup',
  payload: { groupId: gid, name: '客户端', color: 'amber', icon: 'star', pinned: true },
})
const updated = next.payload.groups.find(group => group.id === gid)
check('updateGroup applies every field at once',
  updated.name === '客户端' && updated.color === 'amber' && updated.icon === 'star' && updated.pinned === true,
  JSON.stringify(updated))

next = await primary.call(mod.MUTATE_PATH, { action: 'updateGroup', payload: { groupId: gid, collapsed: true } })
check('a group can be collapsed', next.payload.groups.find(group => group.id === gid).collapsed === true)
next = await primary.call(mod.MUTATE_PATH, { action: 'updateGroup', payload: { groupId: 'no-such-group', name: 'x' } })
check('an unknown group id in updateGroup is a no-op', next.status === 200
  && next.payload.groups.find(group => group.id === gid).name === '客户端')

// Hostile values must be coerced or dropped, never stored verbatim.
next = await primary.call(mod.MUTATE_PATH, {
  action: 'createGroup', payload: { name: 'x'.repeat(200), color: 'chartreuse', icon: 'skull' },
})
const coerced = next.payload.groups.at(-1)
check('an unknown accent cannot enter the document', coerced.color === 'blue', String(coerced.color))
check('an unknown glyph cannot enter the document', coerced.icon === 'folder', String(coerced.icon))
check('an over-long name is truncated', coerced.name.length <= 40, `${coerced.name.length} chars`)
await primary.call(mod.MUTATE_PATH, { action: 'deleteGroup', payload: { groupId: coerced.id } })

// ═══════════════════════════════════════════════════════════════════════
// Projects
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ projects')
next = await primary.call(mod.MUTATE_PATH, { action: 'assignWorkspace', payload: { workspaceId: 'ws-a', groupId: gid } })
check('assignWorkspace records the membership', next.payload.assign['ws-a'] === gid, JSON.stringify(next.payload.assign))
check('assignWorkspace appends to the section order', next.payload.orders[gid].includes('ws-a'),
  JSON.stringify(next.payload.orders))

next = await primary.call(mod.MUTATE_PATH, { action: 'assignWorkspace', payload: { workspaceId: 'ws-b', groupId: gid } })
check('a second project joins the same group', next.payload.orders[gid].length === 2, JSON.stringify(next.payload.orders[gid]))

next = await primary.call(mod.MUTATE_PATH, { action: 'assignWorkspace', payload: { workspaceId: 'ws-a', groupId: '' } })
check('assigning the empty group id detaches it', next.payload.assign['ws-a'] === undefined,
  JSON.stringify(next.payload.assign))
check('detaching moves it to the ungrouped order', next.payload.orders.__ungrouped__.includes('ws-a'),
  JSON.stringify(next.payload.orders))
check('detaching removes it from its former section', !next.payload.orders[gid].includes('ws-a'),
  JSON.stringify(next.payload.orders[gid]))

// A stale page can address a group that no longer exists; that must not throw.
next = await primary.call(mod.MUTATE_PATH, { action: 'assignWorkspace', payload: { workspaceId: 'ws-a', groupId: 'gone' } })
check('an unknown group id falls back to ungrouped', next.status === 200 && next.payload.assign['ws-a'] === undefined,
  JSON.stringify(next.payload.assign))
check('an unknown group id leaves no error on the document', next.payload.error === null, String(next.payload.error))

next = await primary.call(mod.MUTATE_PATH, {
  action: 'orderWorkspace', payload: { workspaceId: 'ws-b', groupId: gid, beforeWorkspaceId: '' },
})
check('orderWorkspace keeps the section order writable', Array.isArray(next.payload.orders[gid]))
next = await primary.call(mod.MUTATE_PATH, { action: 'orderWorkspace', payload: { workspaceId: 'ws-b', groupId: gid } })
check('orderWorkspace after an empty anchor appends', next.payload.orders[gid].at(-1) === 'ws-b')

next = await primary.call(mod.MUTATE_PATH, {
  action: 'setWorkspaceState', payload: { workspaceId: 'ws-b', expanded: true, showAll: true },
})
check('setWorkspaceState stores fold state per project', next.payload.workspaceState['ws-b'].expanded === true
  && next.payload.workspaceState['ws-b'].showAll === true, JSON.stringify(next.payload.workspaceState))
next = await primary.call(mod.MUTATE_PATH, { action: 'setWorkspaceState', payload: { workspaceId: 'ws-b', expanded: false } })
check('setWorkspaceState keeps the untouched field', next.payload.workspaceState['ws-b'].showAll === true
  && next.payload.workspaceState['ws-b'].expanded === false, JSON.stringify(next.payload.workspaceState))

next = await primary.call(mod.MUTATE_PATH, {
  action: 'orderGroup', payload: { groupId: gid2, pinned: false, order: [gid], beforeGroupId: '' },
})
check('orderGroup renumbers the target section', next.payload.groups.find(group => group.id === gid2).order === 0,
  next.payload.groups.map(group => `${group.id}:${group.pinned}:${group.order}`).join(' '))
check('orderGroup does not disturb the other section', next.payload.groups.find(group => group.id === gid).pinned === true,
  'a pinned group and an unpinned one number their own sections')

// The insertion rule the client depends on: the moved group lands at the index
// its `beforeGroupId` occupies IN THE SENT LIST. A client that filters the
// destination out of `order` therefore appends instead of inserting, which on a
// two-row tree is indistinguishable from "the menu did nothing".
const a = (await primary.call(mod.MUTATE_PATH, { action: 'createGroup', payload: { name: 'A' } })).payload.groups.at(-1).id
const b = (await primary.call(mod.MUTATE_PATH, { action: 'createGroup', payload: { name: 'B' } })).payload.groups.at(-1).id
next = await primary.call(mod.MUTATE_PATH, {
  action: 'orderGroup', payload: { groupId: b, pinned: false, order: [a, gid2], beforeGroupId: '' },
})
check('a reorder with an empty destination appends', next.payload.groups.find(group => group.id === b).order
  > next.payload.groups.find(group => group.id === a).order,
  next.payload.groups.map(group => `${group.id}#${group.order}`).join(' '))
next = await primary.call(mod.MUTATE_PATH, {
  action: 'orderGroup', payload: { groupId: b, pinned: false, order: [a, gid2], beforeGroupId: a },
})
check('a reorder before a listed destination really inserts it first',
  next.payload.groups.find(group => group.id === b).order < next.payload.groups.find(group => group.id === a).order,
  next.payload.groups.map(group => `${group.id}#${group.order}`).join(' '))
next = await primary.call(mod.MUTATE_PATH, {
  action: 'orderGroup', payload: { groupId: b, pinned: false, order: [gid2], beforeGroupId: a },
})
check('an unlisted destination degrades to an append, not an insertion',
  next.payload.groups.find(group => group.id === b).order > next.payload.groups.find(group => group.id === gid2).order,
  'this is the shape the client used to send; the Host is behaving as specified')

// ═══════════════════════════════════════════════════════════════════════
// Whole-tree operations
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ whole-tree operations')
next = await primary.call(mod.MUTATE_PATH, { action: 'collapseAll' })
check('collapseAll folds every group', next.payload.groups.every(group => group.collapsed === true),
  JSON.stringify(next.payload.groups.map(group => group.collapsed)))
check('collapseAll also folds every project', Object.values(next.payload.workspaceState).every(view => view.expanded === false),
  JSON.stringify(next.payload.workspaceState))
next = await primary.call(mod.MUTATE_PATH, { action: 'expandAll' })
check('expandAll unfolds every group', next.payload.groups.every(group => group.collapsed === false))

next = await primary.call(mod.MUTATE_PATH, { action: 'setView', payload: { view: 'recent' } })
check('setView switches the view mode', next.payload.ui.view === 'recent')
next = await primary.call(mod.MUTATE_PATH, { action: 'setView', payload: { view: 'grouped' } })
check('setView switches back', next.payload.ui.view === 'grouped')
next = await primary.call(mod.MUTATE_PATH, { action: 'setView', payload: { view: 'nonsense' } })
check('an unknown view falls back to grouped', next.payload.ui.view === 'grouped', String(next.payload.ui.view))

next = await primary.call(mod.MUTATE_PATH, { action: 'archiveGroup', payload: { groupId: gid } })
check('archiveGroup removes it from the tree', next.payload.groups.every(group => group.id !== gid))
check('archiveGroup keeps it in the archive drawer', next.payload.archivedGroups.some(group => group.id === gid),
  JSON.stringify(next.payload.archivedGroups.map(group => group.id)))
next = await primary.call(mod.MUTATE_PATH, { action: 'unarchiveGroup', payload: { groupId: gid } })
check('unarchiveGroup restores it', next.payload.groups.some(group => group.id === gid)
  && next.payload.archivedGroups.every(group => group.id !== gid))

// ═══════════════════════════════════════════════════════════════════════
// Deleting a group: the safety default
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ deleting a group')
next = await primary.call(mod.MUTATE_PATH, { action: 'deleteGroup', payload: { groupId: gid } })
check('deleting without a flag DISSOLVES the group', next.payload.groups.every(group => group.id !== gid),
  'the safe branch must be the default')
check('a dissolved group returns its projects to ungrouped', next.payload.assign['ws-b'] === undefined,
  JSON.stringify(next.payload.assign))
check('a dissolved group leaves its projects listed', next.payload.orders.__ungrouped__.includes('ws-b'),
  JSON.stringify(next.payload.orders))

// With `withProjects`, DSH unregisters the workspaces itself; the store must not
// also pile them into the ungrouped section, or a deleted project would reappear.
next = await primary.call(mod.MUTATE_PATH, {
  action: 'createGroup', payload: { name: '要删的组', color: 'red', icon: 'bug', workspaceId: 'ws-c' },
})
const doomed = next.payload.groups.at(-1).id
next = await primary.call(mod.MUTATE_PATH, { action: 'deleteGroup', payload: { groupId: doomed, withProjects: true } })
check('a group deleted with its projects leaves nothing behind', !next.payload.orders[doomed]
  && !next.payload.orders.__ungrouped__.includes('ws-c'), JSON.stringify(next.payload.orders))

next = await primary.call(mod.MUTATE_PATH, { action: 'prune', payload: { workspaceIds: ['ws-b', 'ws-a'] } })
check('prune drops assignments for unknown workspaces', Object.keys(next.payload.assign).length === 0,
  JSON.stringify(next.payload.assign))

// ═══════════════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ persistence')
await primary.call(mod.MUTATE_PATH, { action: 'createGroup', payload: { name: '持久化', color: 'violet', icon: 'briefcase' } })
const reread = await primary.call(mod.STATE_PATH)
check('a re-read reflects the latest mutation', reread.payload.groups.some(group => group.name === '持久化'),
  JSON.stringify(reread.payload.groups.map(group => group.name)))
check('the state file exists on disk', existsSync(reread.payload.file), reread.payload.file)

/** Wait past the write chain, then read what the store actually wrote. */
await new Promise(resolve => setTimeout(resolve, 400))
let onDisk = null
try {
  onDisk = JSON.parse(readFileSync(reread.payload.file, 'utf8'))
} catch (error) {
  console.log('    (read failed)', error.message)
}
check('the on-disk document is valid JSON', onDisk !== null)
check('the on-disk document matches memory', onDisk !== null
  && onDisk.groups.length === reread.payload.groups.length,
  onDisk === null ? '' : `${onDisk.groups.length} vs ${reread.payload.groups.length}`)
check('the on-disk document is normalized', onDisk !== null && onDisk.version === 1 && typeof onDisk.assign === 'object')
check('the on-disk document has no diag fields', onDisk !== null && onDisk.settings === undefined && onDisk.file === undefined,
  'only the document itself is written, not the snapshot wrapper')
check('the temp file was renamed away', !existsSync(`${reread.payload.file}.tmp`))

// A second mount over the SAME home must read what the first one wrote.
const second = mount(primary.home)
const reloaded = await second.call(mod.STATE_PATH)
check('a remount reads the persisted document', reloaded.payload.groups.some(group => group.name === '持久化'),
  JSON.stringify(reloaded.payload.groups.map(group => group.name)))

// ═══════════════════════════════════════════════════════════════════════
// Corruption recovery
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ a corrupted state file')
const corruptHome = freshHome()
const corruptPath = join(corruptHome, 'workspace-groups', 'state.json')
mkdirSync(dirname(corruptPath), { recursive: true })
writeFileSync(corruptPath, '{ this is not json at all', 'utf8')
const corrupt = mount(corruptHome)
const afterCorruption = await corrupt.call(mod.STATE_PATH)
check('a corrupted file does not break the read', afterCorruption.status === 200, String(afterCorruption.status))
check('a corrupted file yields an empty but well-formed document',
  afterCorruption.payload.groups.length === 0 && afterCorruption.payload.version === 1,
  `groups=${afterCorruption.payload.groups.length}`)
check('the corruption is reported, not hidden', typeof afterCorruption.payload.error === 'string',
  String(afterCorruption.payload.error))
check('the unreadable bytes are preserved for diagnosis', existsSync(`${corruptPath}.bad`))
check('the host logged the corruption', corrupt.warnings.some(line => line.includes('unreadable')),
  corrupt.warnings.join(' | '))
const recovery = await corrupt.call(mod.MUTATE_PATH, { action: 'createGroup', payload: { name: '恢复', color: 'teal', icon: 'flask' } })
check('the document is writable again', recovery.payload.groups.length === 1)
check('the recovery clears the reported error', recovery.payload.error === null, String(recovery.payload.error))

// A structurally valid but hostile document is repaired rather than rejected.
const hostileHome = freshHome()
const hostilePath = join(hostileHome, 'workspace-groups', 'state.json')
mkdirSync(dirname(hostilePath), { recursive: true })
writeFileSync(hostilePath, JSON.stringify({
  version: 99,
  groups: [{ id: 'g1', name: 'ok' }, { name: 'no id' }, { id: '', name: 'empty id' }, null, { id: 'g2', color: 'neon', icon: 'dragon', order: 'NaN' }],
  archivedGroups: 'not an array',
  assign: { 'ws-x': 'g1', 'ws-y': 42, '': 'g1' },
  orders: { g1: ['ws-x', 7, null], g2: 'nope' },
  workspaceState: { 'ws-x': { expanded: 'yes' } },
  ui: { view: 'matrix' },
  extraField: { should: 'be dropped' },
}), 'utf8')
const hostile = mount(hostileHome)
const repaired = await hostile.call(mod.STATE_PATH)
check('unusable group records are dropped', repaired.payload.groups.length === 2,
  JSON.stringify(repaired.payload.groups.map(group => group.id)))
check('an unknown accent is replaced', repaired.payload.groups.every(group => group.color !== 'neon'))
check('an unknown glyph is replaced', repaired.payload.groups.every(group => group.icon !== 'dragon'))
check('a non-array archive set becomes empty', Array.isArray(repaired.payload.archivedGroups)
  && repaired.payload.archivedGroups.length === 0)
check('noise entries in assign/orders are dropped', JSON.stringify(repaired.payload.assign) === '{"ws-x":"g1"}'
  && JSON.stringify(repaired.payload.orders) === '{"g1":["ws-x"]}',
  `${JSON.stringify(repaired.payload.assign)} ${JSON.stringify(repaired.payload.orders)}`)
check('a non-boolean fold flag is coerced', repaired.payload.workspaceState['ws-x'].expanded === false)
check('an unknown view falls back to grouped', repaired.payload.ui.view === 'grouped')
check('unknown top-level fields are dropped', repaired.payload.extraField === undefined)
check('the repaired document reports no error', repaired.payload.error === null)

// ═══════════════════════════════════════════════════════════════════════
// Request validation
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ request validation')
const noAction = await primary.call(mod.MUTATE_PATH, {})
check('a body with no action is rejected', noAction.status === 400, String(noAction.status))
const badAction = await primary.call(mod.MUTATE_PATH, { action: 42 })
check('a non-string action is rejected', badAction.status === 400, String(badAction.status))
const badJson = await primary.call(mod.MUTATE_PATH, '{not json')
check('unparseable JSON is rejected', badJson.status === 400, String(badJson.status))
const huge = await primary.call(mod.MUTATE_PATH, JSON.stringify({ action: 'createGroup', payload: { name: 'x'.repeat(70 * 1024) } }))
check('an oversized body is rejected', huge.status === 413, String(huge.status))
const emptyBody = await primary.call(mod.MUTATE_PATH, '')
check('an empty body is rejected as missing an action', emptyBody.status === 400, String(emptyBody.status))

// A newer browser half talking to an older host must not fail the sidebar.
const unknown = await primary.call(mod.MUTATE_PATH, { action: 'unknown-action-from-a-newer-browser' })
check('an unknown action is a no-op answered with the document', unknown.status === 200
  && Array.isArray(unknown.payload.groups), String(unknown.status))

// ═══════════════════════════════════════════════════════════════════════
// Seeding and the disabled row
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ seeding')
const seeded = mount(freshHome(), {
  enabled: true,
  previewSessions: 1,
  searchLimit: 20,
  seedGroups: [{ id: 'seed-1', name: '预建分组', color: 'rose', icon: 'rocket' }, { id: 'bad' }],
})
const seededState = await seeded.call(mod.STATE_PATH)
check('seedGroups creates the configured groups', seededState.payload.groups.some(group => group.id === 'seed-1'),
  JSON.stringify(seededState.payload.groups.map(group => group.id)))
check('a seed entry without a name is still normalized', seededState.payload.groups.some(group => group.id === 'bad')
  && seededState.payload.groups.find(group => group.id === 'bad').name === '')
check('config preview count reaches settings', seededState.payload.settings.previewSessions === 1)
check('config search limit reaches settings', seededState.payload.settings.searchLimit === 20)

console.log('▸ a disabled row')
const disabledHome = freshHome()
process.env.DSH_HOME = disabledHome
const disabledRoutes = new Map()
mod.apply({
  logger: { warn() {} },
  effect: callback => callback(),
  inject(_services, callback) {
    callback({ connection: { fetch: { register: (route) => { disabledRoutes.set(route.path, route); return () => {} } } }, effect: (fn) => fn() })
  },
}, { enabled: false })
check('a disabled row mounts no routes', disabledRoutes.size === 0, `${disabledRoutes.size} routes`)
check('a disabled row writes no state file', !existsSync(join(disabledHome, 'workspace-groups', 'state.json')))

console.log('')
console.log(failures === 0 ? '▸ PASS — every check passed' : `▸ FAIL — ${failures} failing check(s)`)
process.exitCode = failures === 0 ? 0 : 1
