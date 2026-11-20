/**
 * dsh-workspace-groups — host half.
 *
 * Two jobs:
 *
 *   1. Keep the grouping tree: which workspace belongs to which group, group
 *      names/colors/icons/flags, per-group project order, fold states, view
 *      mode, and archived groups. This is plugin-owned view metadata, not a
 *      second source of truth for workspaces: the DSH workspace registry stays
 *      authoritative for what exists, and this store only ever references its
 *      `workspaceId`s (unknown ids render as absent and are pruned lazily).
 *
 *   2. Persist it. One JSON document per SCOPE under the DSH home, published
 *      through an atomic temp-file rename so a crash mid-write can never leave
 *      a half file behind. Reads are served from memory; every mutation is
 *      applied to the in-memory state first, queued behind the previous write,
 *      and answered with the complete new snapshot the browser renders from.
 *
 * A scope is "which workspace list this document describes": `local` for this
 * installation's own sidebar, or the device id of the Remote Host the page is
 * currently connected to. Grouping can only reference workspace ids that the
 * visible list contains, and the local list and a Remote Host's list are
 * disjoint — so one document cannot serve both. The browser half names the
 * scope on every request (`?scope=…`); an absent or malformed key falls back to
 * `local`, which is also the only scope `seedGroups` applies to.
 *
 * The browser half reaches both over two routes registered inside the
 * Connection's authentication fence, so only a page of this host can read or
 * write the tree.
 *
 * @module dsh-workspace-groups
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-workspace-groups'

/** Host route paths the browser half calls (relative to the app origin). */
export const STATE_PATH = '/api/workspace-groups/state'
export const MUTATE_PATH = '/api/workspace-groups/mutate'

/** Accepts at most this many bytes of a mutate body; the tree is small. */
const MAX_BODY_BYTES = 64 * 1024

/** Preset accents; the browser owns the exact hex values for both themes. */
const COLORS = new Set(['blue', 'indigo', 'violet', 'rose', 'red', 'orange', 'amber', 'green', 'teal', 'slate'])
/** Preset glyphs; the browser draws each one. Mirrors the client's ICON_PATHS table. */
const ICONS = new Set([
  'folder', 'star', 'heart', 'flag', 'bookmark', 'bolt', 'flame', 'rocket', 'bug',
  'code', 'terminal', 'book', 'bulb', 'briefcase', 'home', 'flask', 'palette', 'music', 'world', 'lock',
])
/** Upper bounds that keep a corrupted state file from growing without limit. */
const LIMITS = { groups: 200, archived: 200, nameLength: 40, idLength: 64, scopes: 32 }

/**
 * The document scope for this Host's own workspaces.
 *
 * Grouping is per-visible-workspace-list, and the visible list changes when the
 * page is connected to a Remote Host: the same workspace ids cannot appear on
 * both sides, so the same document cannot describe both. The browser half
 * therefore names a scope, and this Host half keeps one document per scope.
 *
 * `local` keeps the historical file path so an installation that never used a
 * Remote Host reads exactly the file it wrote before this feature existed.
 */
const LOCAL_SCOPE = 'local'

/**
 * Accepted scope keys: a device id, or `local`. Deliberately narrow, because
 * the scope reaches a filesystem path — anything with a separator, a dot
 * segment, or a drive colon is refused rather than sanitized.
 */
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Plugin configuration defaults; the row's `config` block overrides each one. */
const DEFAULTS = {
  enabled: true,
  previewSessions: 2,
  persistDebounceMs: 400,
  searchLimit: 80,
  seedGroups: [],
}

/** Read one config field defensively: a hand-edited row must never wedge activation. */
function readConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const number = (value, fallback, min, max) => (typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback)
  return {
    enabled: raw.enabled !== false,
    previewSessions: number(raw.previewSessions, DEFAULTS.previewSessions, 1, 6),
    persistDebounceMs: number(raw.persistDebounceMs, DEFAULTS.persistDebounceMs, 0, 5000),
    searchLimit: number(raw.searchLimit, DEFAULTS.searchLimit, 20, 400),
    seedGroups: Array.isArray(raw.seedGroups) ? raw.seedGroups : [],
  }
}

/** This Host's state directory: `<DSH_HOME>/workspace-groups`. */
function stateDirectory() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'workspace-groups')
}

/**
 * Where one scope's document lives.
 *
 * The local scope keeps the historical `state.json` name: an installation that
 * upgrades to this version must find its existing groups, not an empty store.
 * Every Remote scope gets `state.<scope>.json` beside it. The scope is already
 * pattern-checked by {@link readScope}, so this join cannot escape the
 * directory.
 *
 * @param scope - `local` or a remote device id.
 */
function stateFile(scope) {
  const directory = stateDirectory()
  return scope === LOCAL_SCOPE
    ? join(directory, 'state.json')
    : join(directory, `state.${scope}.json`)
}

/** A fresh, empty tree. Every field is present so the browser never needs a default. */
function emptyState() {
  return {
    version: 1,
    groups: [],
    archivedGroups: [],
    assign: {},
    orders: {},
    workspaceState: {},
    ui: { view: 'grouped' },
  }
}

/** Coerce any stored value into the current schema; unknown fields are dropped. */
function normalize(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object') return state
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  const archived = Array.isArray(raw.archivedGroups) ? raw.archivedGroups : []
  state.groups = groups.map(normalizeGroup).filter(Boolean).slice(0, LIMITS.groups)
  state.archivedGroups = archived.map(normalizeGroup).filter(Boolean).slice(0, LIMITS.archived)
  if (raw.assign !== null && typeof raw.assign === 'object') {
    for (const [workspaceId, groupId] of Object.entries(raw.assign)) {
      if (typeof workspaceId !== 'string' || typeof groupId !== 'string') continue
      if (workspaceId.length === 0 || workspaceId.length > LIMITS.idLength) continue
      state.assign[workspaceId] = groupId
    }
  }
  if (raw.orders !== null && typeof raw.orders === 'object') {
    for (const [groupId, order] of Object.entries(raw.orders)) {
      if (!Array.isArray(order)) continue
      state.orders[groupId] = order.filter(id => typeof id === 'string' && id.length <= LIMITS.idLength)
    }
  }
  if (raw.workspaceState !== null && typeof raw.workspaceState === 'object') {
    for (const [workspaceId, view] of Object.entries(raw.workspaceState)) {
      if (view === null || typeof view !== 'object') continue
      state.workspaceState[workspaceId] = {
        expanded: view.expanded === true,
        showAll: view.showAll === true,
      }
    }
  }
  if (raw.ui !== null && typeof raw.ui === 'object' && (raw.ui.view === 'grouped' || raw.ui.view === 'recent')) {
    state.ui.view = raw.ui.view
  }
  return state
}

/** One group record, or null when unusable. Repairs hostile fields rather than throwing on load. */
function normalizeGroup(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= LIMITS.idLength ? raw.id : null
  if (id === null) return null
  const rawName = typeof raw.name === 'string' ? raw.name.trim() : ''
  return {
    id,
    name: rawName.slice(0, LIMITS.nameLength),
    color: COLORS.has(raw.color) ? raw.color : 'blue',
    icon: ICONS.has(raw.icon) ? raw.icon : 'folder',
    pinned: raw.pinned === true,
    collapsed: raw.collapsed === true,
    order: Number.isFinite(raw.order) ? raw.order : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

/** Next free group id; monotonic against the live and archived sets. */
function nextGroupId(state) {
  const taken = new Set([...state.groups, ...state.archivedGroups].map(group => group.id))
  let index = state.groups.length + state.archivedGroups.length + 1
  let id = `g${index}`
  while (taken.has(id)) id = `g${++index}`
  return id
}

/**
 * Apply one mutation in place.
 *
 * Every action is total: an unknown group, workspace or index is a no-op, so a
 * stale browser page (or a hand-edited file) can never wedge the store. The
 * caller answers with the snapshot no matter which branch ran.
 *
 * @param state - current normalized state; mutated in place.
 * @param action - verb name from the browser half.
 * @param payload - action arguments.
 * @param config - resolved plugin config (preview count, seed groups).
 * @returns the state (same object) after the mutation.
 */
function applyAction(state, action, payload, config) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  switch (action) {
    case 'createGroup': {
      if (state.groups.length >= LIMITS.groups) return state
      const id = nextGroupId(state)
      const group = normalizeGroup({
        id,
        name: typeof body.name === 'string' && body.name.trim().length > 0 ? body.name : 'New group',
        color: body.color,
        icon: body.icon,
        pinned: body.pinned === true,
        collapsed: false,
        order: state.groups.length,
        createdAt: Date.now(),
      })
      // `normalizeGroup` only rejects an unusable id; this one is generated, so
      // the check is a guard against a future change rather than a live branch.
      if (group === null) return state
      state.groups.push(group)
      if (typeof body.workspaceId === 'string' && body.workspaceId.length > 0) {
        state.assign[body.workspaceId] = id
        state.orders[id] = [body.workspaceId]
      }
      return state
    }
    case 'updateGroup': {
      const group = state.groups.find(row => row.id === body.groupId) ?? state.archivedGroups.find(row => row.id === body.groupId)
      if (group === undefined) return state
      if (typeof body.name === 'string') group.name = body.name.trim().slice(0, LIMITS.nameLength)
      if (COLORS.has(body.color)) group.color = body.color
      if (ICONS.has(body.icon)) group.icon = body.icon
      if (typeof body.pinned === 'boolean') group.pinned = body.pinned
      if (typeof body.collapsed === 'boolean') group.collapsed = body.collapsed
      return state
    }
    case 'deleteGroup': {
      const index = state.groups.findIndex(row => row.id === body.groupId)
      if (index === -1) return state
      const group = state.groups[index]
      state.groups.splice(index, 1)
      // Dissolve is the default: projects fall back to Ungrouped. `withProjects`
      // is the deliberate second choice; the browser also deletes the host
      // workspace registrations themselves, which this store must not assume
      // happened, so the ids are simply dropped from the assignment map.
      for (const [workspaceId, groupId] of Object.entries(state.assign)) {
        if (groupId === group.id) delete state.assign[workspaceId]
      }
      if (state.orders[group.id] !== undefined) {
        const remaining = state.orders[group.id]
        delete state.orders[group.id]
        if (body.withProjects !== true) {
          state.orders.__ungrouped__ = [...(state.orders.__ungrouped__ ?? []), ...remaining]
        }
      }
      return state
    }
    case 'assignWorkspace': {
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
      const groupId = typeof body.groupId === 'string' ? body.groupId : ''
      if (workspaceId.length === 0) return state
      // Detach from wherever it was, then attach at the end of the target's order.
      for (const [key, order] of Object.entries(state.orders)) {
        state.orders[key] = order.filter(id => id !== workspaceId)
      }
      // `find` answers with `undefined` for a miss, so coalesce before comparing:
      // an unknown group id must detach the project, never throw on `.id`.
      const target = groupId === '' ? null : (state.groups.find(row => row.id === groupId) ?? null)
      if (target === null) delete state.assign[workspaceId]
      else state.assign[workspaceId] = target.id
      const orderKey = target === null ? '__ungrouped__' : target.id
      const at = Number.isInteger(body.index) ? body.index : Number.MAX_SAFE_INTEGER
      const order = state.orders[orderKey] ?? []
      const insertAt = Math.max(0, Math.min(at, order.length))
      order.splice(insertAt, 0, workspaceId)
      state.orders[orderKey] = order
      return state
    }
    case 'orderGroup': {
      const groupId = typeof body.groupId === 'string' ? body.groupId : ''
      const group = state.groups.find(row => row.id === groupId)
      if (group === undefined) return state
      const beforeId = typeof body.beforeGroupId === 'string' ? body.beforeGroupId : ''
      const pinned = body.pinned === true
      group.pinned = pinned
      // The browser sends the complete target section order; a partial or
      // replayed move still lands deterministically because every row's slot is
      // recomputed from that one list.
      const sent = Array.isArray(body.order) ? body.order.filter(id => typeof id === 'string') : null
      const peers = state.groups.filter(row => row.pinned === pinned && row.id !== groupId)
      const targetIds = sent ?? peers.map(row => row.id)
      const at = targetIds.indexOf(beforeId)
      const sequence = [...peers]
      sequence.splice(at === -1 ? sequence.length : at, 0, group)
      // Pinned groups render before unpinned ones, so each section numbers its
      // own rows and the two sections never share slot values.
      sequence.forEach((row, slot) => { row.order = slot })
      // A row this list did not mention keeps a slot after the section's tail.
      const tail = sequence.length
      for (const row of state.groups) {
        if (row.pinned === pinned && !sequence.includes(row) && row.order >= tail) row.order = tail
      }
      return state
    }
    case 'orderWorkspace': {
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
      if (workspaceId.length === 0) return state
      const groupId = typeof body.groupId === 'string' && body.groupId !== ''
        ? body.groupId
        : (state.assign[workspaceId] ?? '')
      const orderKey = groupId === '' ? '__ungrouped__' : groupId
      const order = (state.orders[orderKey] ?? []).filter(id => id !== workspaceId)
      const beforeId = typeof body.beforeWorkspaceId === 'string' ? body.beforeWorkspaceId : ''
      const before = order.indexOf(beforeId)
      order.splice(before === -1 ? order.length : before, 0, workspaceId)
      state.orders[orderKey] = order
      return state
    }
    case 'setWorkspaceState': {
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
      if (workspaceId.length === 0) return state
      const current = state.workspaceState[workspaceId] ?? { expanded: false, showAll: false }
      state.workspaceState[workspaceId] = {
        expanded: typeof body.expanded === 'boolean' ? body.expanded : current.expanded,
        showAll: typeof body.showAll === 'boolean' ? body.showAll : current.showAll,
      }
      return state
    }
    case 'collapseAll': {
      for (const group of state.groups) group.collapsed = true
      for (const view of Object.values(state.workspaceState)) view.expanded = false
      return state
    }
    case 'expandAll': {
      for (const group of state.groups) group.collapsed = false
      return state
    }
    case 'archiveGroup': {
      const index = state.groups.findIndex(row => row.id === body.groupId)
      if (index === -1) return state
      const [group] = state.groups.splice(index, 1)
      group.pinned = false
      state.archivedGroups.push(group)
      return state
    }
    case 'unarchiveGroup': {
      const index = state.archivedGroups.findIndex(row => row.id === body.groupId)
      if (index === -1) return state
      const [group] = state.archivedGroups.splice(index, 1)
      group.collapsed = false
      group.order = state.groups.length
      state.groups.push(group)
      return state
    }
    case 'setView': {
      if (body.view === 'grouped' || body.view === 'recent') state.ui.view = body.view
      return state
    }
    case 'prune': {
      // Drop references to workspaces the caller proved absent (its own live list).
      const live = new Set(Array.isArray(body.workspaceIds) ? body.workspaceIds.filter(id => typeof id === 'string') : [])
      for (const workspaceId of Object.keys(state.assign)) {
        if (!live.has(workspaceId)) delete state.assign[workspaceId]
      }
      for (const [key, order] of Object.entries(state.orders)) {
        state.orders[key] = order.filter(id => live.has(id))
      }
      for (const workspaceId of Object.keys(state.workspaceState)) {
        if (!live.has(workspaceId)) delete state.workspaceState[workspaceId]
      }
      return state
    }
    case 'seed': {
      // One-time convenience from `config.seedGroups`; existing ids are left alone.
      for (const raw of Array.isArray(config.seedGroups) ? config.seedGroups : []) {
        if (raw === null || typeof raw !== 'object') continue
        if (typeof raw.id !== 'string' || raw.id.length === 0) continue
        if (state.groups.some(row => row.id === raw.id)) continue
        const group = normalizeGroup({ ...raw, order: state.groups.length, createdAt: Date.now() })
        if (group === null) continue
        state.groups.push(group)
      }
      return state
    }
    default:
      return state
  }
}

/**
 * Read the scope a request asks for.
 *
 * The browser half names the scope it is rendering for (`?scope=<deviceId>`,
 * or `?scope=local`). An absent or malformed value falls back to the local
 * scope rather than failing the request: a page that predates this feature, or
 * one whose device id the Host refuses, must still get a working tree.
 *
 * @param request - the incoming route request.
 * @returns a pattern-checked scope key.
 */
function readScope(request) {
  let raw
  try {
    raw = new URL(request.url, 'http://dsh.internal').searchParams.get('scope')
  } catch {
    return LOCAL_SCOPE
  }
  if (typeof raw !== 'string') return LOCAL_SCOPE
  return SCOPE_PATTERN.test(raw) ? raw : LOCAL_SCOPE
}

/**
 * One store per scope: one in-memory state, one write queue, one atomic
 * publisher.
 *
 * Scopes are the reason this is a factory: the page can be connected to this
 * Host (`local`) or to a Remote Host (`<deviceId>`), and those two see
 * different workspace lists. Keeping one document each stops a Remote
 * connection from rewriting the local grouping, and vice versa — the mismatch
 * this feature exists to remove.
 *
 * @param config - resolved plugin config.
 * @param logger - Host logger, for state-file trouble.
 * @param scope - `local` or a remote device id; also the state file suffix.
 */
function createStore(config, logger, scope) {
  const file = stateFile(scope)
  let state = emptyState()
  let loaded = false
  let queue = Promise.resolve()
  let lastError = null

  /** Load once, tolerating absent and corrupt documents. */
  const load = () => {
    if (loaded) return
    loaded = true
    try {
      if (!existsSync(file)) return
      const text = readFileSync(file, 'utf8')
      state = normalize(JSON.parse(text))
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`workspace-groups: state file unreadable (${lastError}); starting empty`)
      try {
        // Keep the unreadable bytes for diagnosis instead of overwriting them silently.
        renameSync(file, `${file}.bad`)
      } catch { /* a rename that fails leaves the original in place; the next write replaces it */ }
    }
  }
  /** Atomic publish: write the sibling temp file, then rename over the real one. */
  const persist = () => {
    const text = `${JSON.stringify(state, null, 2)}\n`
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  }
  /** Run one mutation on the write chain; resolves after durability. */
  const commit = (action, payload) => {
    queue = queue.then(() => {
      applyAction(state, action, payload, config)
      persist()
      // A successful publish means the document on disk now matches memory, so
      // an earlier read or write failure is history, not a standing condition.
      lastError = null
    }).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`workspace-groups: persist failed (${lastError})`)
      // A failed write must not stop later writes: the next successful publish
      // rewrites the whole document from memory, so this is recoverable.
      queue = Promise.resolve()
    })
    return queue
  }
  load()
  // Seed synchronously, before the first read can be answered: a configured
  // group that only appeared after some later write would look like a bug on
  // the very first page load.
  //
  // Only the local scope is seeded. `seedGroups` is an operator convenience for
  // this installation's own sidebar, and planting the same groups into every
  // Remote Host the user connects to would be noise they never asked for.
  if (scope === LOCAL_SCOPE && Array.isArray(config.seedGroups) && config.seedGroups.length > 0) {
    applyAction(state, 'seed', {}, config)
    void commit('seed', {})
  }
  return {
    /**
     * Complete snapshot for the browser, with the resolved settings and a
     * diagnostics tail.
     *
     * `scope` is echoed so the browser half can tell which document it is
     * holding: it names the scope on every request, but only the answer proves
     * the Host agreed (a malformed key falls back to `local`).
     */
    snapshot() {
      return {
        ...state,
        scope,
        settings: { previewSessions: config.previewSessions, searchLimit: config.searchLimit },
        persisted: lastError === null,
        error: lastError,
        file,
      }
    },
    /** Apply and durably store one action. */
    async mutate(action, payload) {
      await commit(action, payload)
      return this.snapshot()
    },
  }
}

/** JSON response helper with the no-store cache policy. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Host body: mount the store and its two routes inside the Connection fence.
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config) {
  const resolved = readConfig(config)
  if (!resolved.enabled) return
  // Seeding happens inside `createStore`, before the first route answers.
  const stores = new Map()
  /**
   * The store for one scope, created on first use.
   *
   * Stores are cached rather than rebuilt per request: each one owns an
   * in-memory document and a write queue, so rebuilding it would re-read the
   * file on every keystroke and could interleave two queues over one file.
   * The cache is bounded: a page that invents scope keys cannot grow the
   * process without limit, and an over-limit scope simply gets a fresh
   * throwaway store it can still read and write in memory.
   *
   * @param scope - `local` or a device id, already pattern-checked.
   */
  const storeFor = (scope) => {
    const existing = stores.get(scope)
    if (existing !== undefined) return existing
    const created = createStore(resolved, ctx.logger, scope)
    if (stores.size < LIMITS.scopes) stores.set(scope, created)
    return created
  }

  ctx.inject(['connection'], (cctx) => {
    const conn = cctx.connection
    if (conn === undefined || conn === null || typeof conn.fetch?.register !== 'function') return

    /** Register one exact route; a composition without the fetch face is simply headless. */
    const mount = (path, methods, handler, label) => {
      try {
        cctx.effect(() => conn.fetch.register({
          path,
          methods,
          requestBody: 'buffered',
          fetch: handler,
        }), `workspace-groups: ${label}`)
      } catch (error) {
        ctx.logger?.warn?.(`workspace-groups: ${label} skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    mount(STATE_PATH, ['GET'], request => json(storeFor(readScope(request)).snapshot()), 'state route')
    mount(MUTATE_PATH, ['POST'], async (request) => {
      let body
      try {
        const text = await request.text()
        if (text.length > MAX_BODY_BYTES) return json({ error: 'body-too-large' }, 413)
        body = text.length === 0 ? {} : JSON.parse(text)
      } catch {
        return json({ error: 'invalid-json' }, 400)
      }
      if (body === null || typeof body !== 'object' || typeof body.action !== 'string') {
        return json({ error: 'invalid-action' }, 400)
      }
      try {
        const scope = readScope(request)
        const snapshot = await storeFor(scope).mutate(body.action, body.payload ?? {})
        return json(snapshot)
      } catch (error) {
        return json({ error: 'mutate-failed', message: error instanceof Error ? error.message : String(error) }, 500)
      }
    }, 'mutate route')
  })
}
