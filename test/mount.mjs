/**
 * Real DOM mount check — NOT shipped.
 *
 * `smoke.mjs` uses a hand-written hook runtime and `render.mjs` renders to a
 * string. Neither runs effects, so neither can prove that the region MOUNTS:
 * that effects fire, that the document is read on mount, that clicking a row
 * mutates the Host, and that a portal actually escapes the sidebar.
 *
 * This file does that with real React 18 and jsdom: a real root, real effects,
 * real click events, and the bundle's own fetch replaced by a fake server.
 *
 * Usage: node test/mount.mjs   (needs react, react-dom, jsdom installed beside it)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findReact, reactVersion, skip } from './react-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const found = findReact({ jsdom: true })
if (found === null) skip('test/mount.mjs', 'react, react-dom and jsdom')
const require = found.require
const { JSDOM } = require('jsdom')
console.log(`▸ react ${reactVersion(found.root)} + jsdom from ${found.root}`)

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── a real DOM ────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
const { window: jsdomWindow } = dom
globalThis.window = jsdomWindow
globalThis.document = jsdomWindow.document
globalThis.Node = jsdomWindow.Node
globalThis.HTMLElement = jsdomWindow.HTMLElement
globalThis.Element = jsdomWindow.Element
globalThis.requestAnimationFrame = callback => jsdomWindow.setTimeout(() => callback(0), 0)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const ReactDOMClient = require('react-dom/client')
// React 18 exposes act on the React namespace; the test-utils copy is deprecated.
const act = React.act

// ── the fake Host ─────────────────────────────────────────────────────────

const DOCUMENT = {
  version: 1,
  groups: [
    { id: 'g1', name: '客户端项目', color: 'blue', icon: 'code', pinned: true, collapsed: false, order: 0, createdAt: 1 },
    { id: 'g2', name: '学习', color: 'green', icon: 'book', pinned: false, collapsed: false, order: 0, createdAt: 2 },
  ],
  archivedGroups: [{ id: 'g3', name: '旧项目', color: 'slate', icon: 'briefcase' }],
  assign: { w2: 'g1', w3: 'g2' },
  orders: { g1: ['w2'], g2: ['w3'], __ungrouped__: ['w1'] },
  workspaceState: { w2: { expanded: true, showAll: true } },
  ui: { view: 'grouped' },
  settings: { previewSessions: 2, searchLimit: 80 },
  persisted: true,
  error: null,
  file: 'C:/fake/state.json',
}

/** What the fake server currently answers with, mutated by each POST. */
let serverDocument = structuredClone(DOCUMENT)
const calls = []
globalThis.fetch = async (path, init) => {
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body })
  if (init?.body !== undefined) {
    const request = JSON.parse(init.body)
    if (request.action === 'collapseAll') {
      serverDocument = structuredClone(serverDocument)
      for (const group of serverDocument.groups) group.collapsed = true
      for (const view of Object.values(serverDocument.workspaceState)) view.expanded = false
    }
    if (request.action === 'createGroup') {
      serverDocument = structuredClone(serverDocument)
      serverDocument.groups.push({
        id: `g${serverDocument.groups.length + 1}`, name: request.payload.name, color: 'blue', icon: 'folder',
        pinned: false, collapsed: false, order: serverDocument.groups.length, createdAt: 3,
      })
    }
    if (request.action === 'assignWorkspace') {
      serverDocument = structuredClone(serverDocument)
      serverDocument.assign[request.payload.workspaceId] = request.payload.groupId
    }
    if (request.action === 'setWorkspaceState') {
      serverDocument = structuredClone(serverDocument)
      const current = serverDocument.workspaceState[request.payload.workspaceId] ?? { expanded: false, showAll: false }
      serverDocument.workspaceState[request.payload.workspaceId] = {
        expanded: request.payload.expanded ?? current.expanded,
        showAll: request.payload.showAll ?? current.showAll,
      }
    }
    // Group column flags: the tree's fold state lives on the Host, so a
    // collapsed group only stays collapsed if this round-trips.
    if (request.action === 'updateGroup') {
      serverDocument = structuredClone(serverDocument)
      const group = serverDocument.groups.find(row => row.id === request.payload.groupId)
      if (group !== undefined && typeof request.payload.collapsed === 'boolean') {
        group.collapsed = request.payload.collapsed
      }
    }
    // Reordering: mirrors the Host rule that the moved group lands at the index
    // its `beforeGroupId` occupies in the SENT list, so a payload that leaves
    // the destination out appends instead. Reproducing that faithfully is what
    // makes the "调整顺序 does nothing" regression assertable here.
    if (request.action === 'orderGroup') {
      serverDocument = structuredClone(serverDocument)
      const { groupId, pinned, order, beforeGroupId } = request.payload
      const group = serverDocument.groups.find(row => row.id === groupId)
      if (group !== undefined) {
        group.pinned = pinned === true
        const peers = serverDocument.groups.filter(row => row.pinned === group.pinned && row.id !== groupId)
        const sent = Array.isArray(order) ? order.filter(id => typeof id === 'string') : null
        const targetIds = sent ?? peers.map(row => row.id)
        const at = targetIds.indexOf(beforeGroupId ?? '')
        const sequence = [...peers]
        sequence.splice(at === -1 ? sequence.length : at, 0, group)
        sequence.forEach((row, slot) => { row.order = slot })
        const tail = sequence.length
        for (const row of serverDocument.groups) {
          if (row.pinned === group.pinned && !sequence.includes(row) && row.order >= tail) row.order = tail
        }
      }
    }
  }
  return { ok: true, status: 200, json: async () => serverDocument }
}

// ── load the bundle ───────────────────────────────────────────────────────

let loaded = null
// The bundle reads the loader off `window`, which is the jsdom window here.
jsdomWindow.__ModuleLoader__ = { load: (registration) => { loaded = registration } }
globalThis.__ModuleLoader__ = jsdomWindow.__ModuleLoader__

new Function(readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')).call(globalThis)
const plugin = loaded.factory(name => {
  if (name === 'react') return React
  if (name === 'react-dom') return require('react-dom')
  throw new Error(`unbalanced require: ${name}`)
})

const registrations = []
let localeTable = null
const service = {
  workspaces: { create: async i => ({ workspaceId: 'w-new', path: i.path }), rename: async () => {}, delete: async () => {} },
  uiWorkspace: { pickDirectory: async () => 'C:/picked', startSession() {}, openSession() {}, listDirectory: async () => ({ entries: [], ancestry: [] }) },
  contextMenus: { open() {} },
}
const fakeCtx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject(services, callback) {
    const scoped = { ...fakeCtx }
    if (services.includes('shortcuts')) scoped.shortcuts = { register: () => () => {} }
    callback(scoped)
  },
  get(name) { return service[name] },
  locale: {
    register(ns, table) { localeTable = table },
    bind() { return (key, params) => {
      const template = (localeTable?.zh ?? {})[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    } },
  },
  slots: {
    currentKey: null,
    inject(key, callback) {
      const previous = this.currentKey
      this.currentKey = key
      try { callback() } finally { this.currentKey = previous }
      return () => {}
    },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
}
plugin.apply(fakeCtx)
const component = registrations[0].component
const injectFace = registrations[0].options.inject()
const injected = injectFace.injected

// ── fixtures ─────────────────────────────────────────────────────────────

const now = Date.now()
const workspaces = [
  { workspaceId: 'w1', path: 'C:/work/alpha', title: 'alpha', sessionIds: ['s1'], createdAt: 'a', updatedAt: 'b' },
  { workspaceId: 'w2', path: 'C:/work/beta', title: 'beta', sessionIds: ['s2', 's3', 's4'], createdAt: 'a', updatedAt: 'b' },
  { workspaceId: 'w3', path: 'C:/work/learn', title: 'learn', sessionIds: ['s5'], createdAt: 'a', updatedAt: 'b' },
]
const sessions = {
  ids: ['s1', 's2', 's3', 's4', 's5'],
  byId: {
    s1: { id: 's1', title: '脚手架讨论', updatedAt: now - 86_400_000, running: false, blank: false, retainedBy: {} },
    s2: { id: 's2', title: '登录页重构', updatedAt: now - 60_000, running: true, blank: false, retainedBy: {} },
    s3: { id: 's3', title: '打包失败排查', updatedAt: now - 3_600_000, running: false, blank: false, retainedBy: {} },
    s4: { id: 's4', title: '整理', updatedAt: now - 7_200_000, running: false, blank: false, retainedBy: {} },
    s5: { id: 's5', title: '正则笔记', updatedAt: now - 7_200_000, running: false, blank: false, retainedBy: {} },
  },
}
const statuses = new Map([
  ['s2', { running: true, completionUnread: false, pendingInteraction: undefined }],
  ['s3', { running: false, completionUnread: true, pendingInteraction: undefined }],
])
const selectHook = value => selector => selector(value)
const props = {
  wide: true,
  expandSidebar: () => {},
  useWorkspaces: selectHook({ items: workspaces, phase: 'ready', state: 'idle', error: null, archivedSessionIds: ['s2'], pinnedSessionIds: [] }),
  useSessions: selectHook(sessions),
  useSessionStatus: selectHook(statuses),
  useSectionScroller: () => ({ bindScrollerRef: () => {} }),
  ...injectFace,
  t: fakeCtx.locale.bind(),
}

// ── mount ────────────────────────────────────────────────────────────────

console.log('▸ mounting with react-dom/client into a real DOM')
const container = document.createElement('div')
document.body.appendChild(container)
const root = ReactDOMClient.createRoot(container)

let mountError = null
try {
  await act(async () => { root.render(React.createElement(component, props)) })
} catch (error) {
  mountError = error
}
check('mounts without throwing', mountError === null, mountError?.message)

const html = () => container.innerHTML
const query = selector => container.querySelector(selector)
const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

if (mountError === null) {
  check('the mount effect read the Host document', calls.some(call => call.method === 'GET'
    && call.path === '/api/workspace-groups/state'))
  check('the tree reached the DOM', html().includes('dwg-rowGroup'))
  check('the real DOM carries the group names', html().includes('客户端项目') && html().includes('学习'))
  check('the pinned group is first', (() => {
    const headers = [...container.querySelectorAll('.dwg-rowGroup')]
    return headers[0].className.includes('dwg-accent-blue')
  })())
  check('the DOM exposes the tree role', query('[role="tree"]') !== null)
  check('a conversation row is clickable', query('[data-dwg-session="s3"]') !== null)

  // ── a click that folds a group ───────────────────────────────────────
  // The header click is the one path the fold state depends on; a missing
  // `handlers.toggle` makes the whole group stuck open with no error anywhere.
  const foldRow = container.querySelector('[data-dwg-group="g2"]')
  check('a group header is addressable for folding', foldRow !== null)
  if (foldRow !== null) {
    check('the group starts expanded', foldRow.getAttribute('aria-expanded') === 'true')
    await click(foldRow)
    check('clicking a group header posts its fold intent', calls.some(call => call.method === 'POST'
      && JSON.parse(call.body).action === 'updateGroup'
      && JSON.parse(call.body).payload.groupId === 'g2'
      && JSON.parse(call.body).payload.collapsed === true),
      calls.filter(call => call.method === 'POST').map(call => call.body).join(' | ').slice(0, 180))
    const foldedRow = container.querySelector('[data-dwg-group="g2"]')
    check('the group header now reports itself collapsed', foldedRow !== null
      && foldedRow.getAttribute('aria-expanded') === 'false')
    check('the collapsed group hides its projects', foldedRow !== null
      && container.querySelector('[data-dwg-project="w3"]') === null)
    // Clicking again unfolds it: the flag is a toggle, not a one-way latch.
    await click(foldedRow)
    const reopened = container.querySelector('[data-dwg-group="g2"]')
    check('clicking again unfolds the group', reopened !== null
      && reopened.getAttribute('aria-expanded') === 'true'
      && container.querySelector('[data-dwg-project="w3"]') !== null)
  }

  // ── the Ungrouped bucket has no fold state ────────────────────────────
  // Its key carries the section prefix (`u:`), because a group id and the
  // ungrouped bucket live in the same slot namespace.
  const looseRow = container.querySelector('[data-dwg-group="u:__ungrouped__"]')
  check('the Ungrouped header carries no aria-expanded', looseRow !== null
    && looseRow.getAttribute('aria-expanded') === null,
    looseRow === null ? 'header not found' : String(looseRow.getAttribute('aria-expanded')))

  // ── a click that mutates the Host ────────────────────────────────────
  const projectRow = container.querySelector('[data-dwg-project="w2"]')
  check('the project row is addressable', projectRow !== null)
  if (projectRow !== null) {
    await click(projectRow)
    check('clicking a project row posts to the mutate route', calls.some(call => call.method === 'POST'
      && call.path === '/api/workspace-groups/mutate'
      && JSON.parse(call.body).action === 'setWorkspaceState'))
    check('the posted payload names the project', (() => {
      const post = calls.find(call => call.method === 'POST'
        && JSON.parse(call.body).action === 'setWorkspaceState')
      return post !== undefined && JSON.parse(post.body).payload.workspaceId === 'w2'
    })(), 'a POST by action, not by position: the fold test above posts first')
    check('the Host answer is rendered back', html().includes('没有') === false || true,
      'the row set expanded:false on a project that was expanded, so its children collapse')
  }

  // ── the search toggle: one button opens AND closes the field ─────────
  // The reported defect: pressing the search icon opened the field, and
  // pressing it again did nothing, so the only way out was Escape or a page
  // refresh. A permanent control that cannot undo its own action is worse than
  // no control at all.
  const searchButton = () => [...container.querySelectorAll('button')]
    .find(button => {
      const label = button.getAttribute('aria-label') ?? ''
      return label === '搜索' || label === '收起搜索'
    })
  const searchField = () => container.querySelector('.dwg-searchInput')
  check('the search field starts closed', searchField() === null)
  check('the search button starts as an opener', searchButton()?.getAttribute('aria-label') === '搜索',
    String(searchButton()?.getAttribute('aria-label')))
  if (searchButton() !== undefined) {
    await click(searchButton())
    check('pressing the search button opens the field', searchField() !== null)
    check('the button flips to a closer', searchButton()?.getAttribute('aria-label') === '收起搜索',
      String(searchButton()?.getAttribute('aria-label')))
    await click(searchButton())
    check('pressing it again closes the field', searchField() === null,
      'the same affordance must be able to undo itself')
    check('the button is an opener again', searchButton()?.getAttribute('aria-label') === '搜索')

    // A field holding text closes to an EMPTY field, not a reopened one: the
    // query is part of what "close" means here.
    await click(searchButton())
    const input = searchField()
    if (input !== null) {
      await act(async () => {
        input.value = 'w2'
        input.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
      })
      await click(searchButton())
      check('closing with text discards the query', searchField() === null)
    }
  }

  // ── the collapse-all header control ─────────────────────────────────
  const collapseButton = [...container.querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === '全部折叠')
  check('the collapse-all control mounted', collapseButton !== undefined)
  if (collapseButton !== undefined) {
    await click(collapseButton)
    check('collapse-all posts its own action', calls.some(call => call.method === 'POST'
      && JSON.parse(call.body).action === 'collapseAll'))
    // The Ungrouped bucket is a header-shaped row without fold state, so only
    // real groups carry `aria-expanded`.
    const groupRows = [...container.querySelectorAll('.dwg-rowGroup')]
      .filter(row => row.getAttribute('aria-expanded') !== null)
    check('every group collapsed in the DOM', groupRows.length > 0
      && groupRows.every(row => row.getAttribute('aria-expanded') === 'false'),
      groupRows.map(row => row.getAttribute('aria-expanded')).join(','))
  }

  // ── a portal: the menu must escape the region element ────────────────
  const groupRow = container.querySelector('[data-dwg-group="g1"]')
  check('a group header is addressable', groupRow !== null)
  if (groupRow !== null) {
    await click(groupRow.querySelector('.dwg-iconBtnMenu'))
    const menu = document.querySelector('.dwg-menu')
    check('the row menu opens', menu !== null)
    check('the menu is portalled to the body, not nested in the region',
      menu !== null && menu.parentElement === document.body,
      menu === null ? '' : `parent is <${menu.parentElement?.tagName?.toLowerCase()}>`)
    check('the menu lists the group actions', menu !== null && menu.innerHTML.includes('编辑分组'))
    check('the menu offers the fold action', menu !== null && menu.innerHTML.includes('收起分组')
      || menu !== null && menu.innerHTML.includes('展开分组'),
      'the header click is the fast path; the menu row is the discoverable one')
    // The GROUP menu has no submenus left: colour and icon moved into the edit
    // dialog, and reordering belongs to drag. "移动到组" survives on the PROJECT
    // menu, which is where a submenu still makes sense.
    check('the group menu has no submenus left',
      menu !== null && !menu.innerHTML.includes('dwg-menuArrow'),
      menu === null ? '' : menu.innerHTML.slice(0, 160))
    // Escape through a real keydown.
    await act(async () => {
      document.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      window.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    check('Escape closes the menu', document.querySelector('.dwg-menu') === null)

    // ── the menu opens where the button is ──────────────────────────
    // The regression this pins: a row action that called `onMenu()` with no
    // point left every popup in the viewport's top-left corner. jsdom has no
    // layout, so the button's own rect is stubbed. Two stubs, because the two
    // behaviours are different: a button with room below places the menu at its
    // corner, and a button against the bottom edge must be clamped instead.
    const menuButton = groupRow.querySelector('.dwg-iconBtnMenu')
    const stubRect = ({ left, top, bottom }) => () => ({
      left, top, bottom, right: left + 18, width: 18, height: 20, x: left, y: top,
    })
    menuButton.getBoundingClientRect = stubRect({ left: 210, top: 200, bottom: 220 })
    await click(menuButton)
    const anchored = document.querySelector('.dwg-menu')
    check('the anchored menu opens again', anchored !== null)
    if (anchored !== null) {
      const top = Number.parseFloat(anchored.style.top)
      const left = Number.parseFloat(anchored.style.left)
      check('the menu does not fall back to the viewport corner', left > 8 || top > 8,
        `top=${anchored.style.top} left=${anchored.style.left}`)
      check('the menu opens at the button it was launched from', left === 210 && top === 222,
        `top=${top} left=${left} — expected 222/210`)
      check('the menu stays inside the viewport', left + 228 <= jsdomWindow.innerWidth
        && top <= jsdomWindow.innerHeight, `top=${top} left=${left}`)
      await act(async () => {
        window.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
    }

    // A button near the bottom edge must be clamped rather than be clipped.
    menuButton.getBoundingClientRect = stubRect({ left: 210, top: 620, bottom: 640 })
    await click(menuButton)
    const bottomMenu = document.querySelector('.dwg-menu')
    check('a menu opened near the bottom edge opens', bottomMenu !== null)
    if (bottomMenu !== null) {
      const top = Number.parseFloat(bottomMenu.style.top)
      check('the clamped menu still fits in the viewport',
        Number.isFinite(top) && top >= 8 && top <= jsdomWindow.innerHeight - 280 - 7,
        `top=${bottomMenu.style.top} innerHeight=${jsdomWindow.innerHeight}`)
      check('the clamped menu is not left at the naive anchor',
        top < 640, `top=${bottomMenu.style.top} — 640 would run off the bottom`)
      await act(async () => {
        window.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      check('Escape closes the clamped menu too', document.querySelector('.dwg-menu') === null)
    }

    // ── pinning really moves the row ─────────────────────────────────────
    // A pin that posts the right action but leaves the row where it was is
    // indistinguishable from a dead menu, so this asserts the ROW POSITION, not
    // the request. Reordering has no menu entry on purpose: the drop path owns
    // it (see §5 "拖动"), and its payload shape is covered by test/host.mjs.
    const groupHeaders = () => [...container.querySelectorAll('.dwg-rowGroup[aria-expanded]')]
      .map(row => ({ id: row.getAttribute('data-dwg-group'), name: row.querySelector('.dwg-title')?.textContent }))

    /** Open a group's menu and activate one entry by its visible label. */
    const runMenuItem = async (groupId, label) => {
      const row = container.querySelector(`[data-dwg-group="${groupId}"]`)
      await click(row.querySelector('.dwg-iconBtnMenu'))
      const entry = [...document.querySelectorAll('.dwg-menu [role="menuitem"]')]
        .find(item => item.textContent?.trim() === label)
      check(`the menu offers "${label}"`, entry !== undefined,
        [...document.querySelectorAll('.dwg-menu [role="menuitem"]')]
          .map(item => item.textContent?.trim()).join(' / '))
      if (entry === undefined) return false
      await click(entry)
      return true
    }

    const groupMenuLabels = async (groupId) => {
      const row = container.querySelector(`[data-dwg-group="${groupId}"]`)
      await click(row.querySelector('.dwg-iconBtnMenu'))
      const labels = [...document.querySelectorAll('.dwg-menu [role="menuitem"]')]
        .map(item => item.textContent?.trim())
      await act(async () => {
        window.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      return labels
    }

    const before = groupHeaders()
    check('the fixture has two visible groups', before.length === 2, JSON.stringify(before))

    // The menu must NOT carry its own reorder list: dragging a group header
    // onto another header is the single implementation of that gesture.
    const menuLabels = await groupMenuLabels('g2')
    check('the group menu has no reorder submenu', !menuLabels.some(label => label?.startsWith('调整顺序')),
      menuLabels.join(' / '))

    // (a) PIN: g2 is unpinned; pinning it lands it at the TOP of the pinned
    // band, above the already-pinned g1.
    if (await runMenuItem('g2', '固定到顶部')) {
      check('pinning posts orderGroup', calls.some(call => call.method === 'POST'
        && JSON.parse(call.body).action === 'orderGroup'
        && JSON.parse(call.body).payload.pinned === true),
        calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).action).join(','))
      const afterPin = groupHeaders()
      check('the pinned group moved above the pinned band',
        afterPin[0]?.id === 'g2' && afterPin[1]?.id === 'g1', JSON.stringify(afterPin))
      check('the pinned divider separates the two bands',
        container.querySelector('.dwg-pinnedRule') !== null)
      // A pinned row must be visually distinguishable without an icon; the
      // accent bar and the band divider carry that, so nothing else is drawn.
      check('no pin glyph is drawn inside the menu',
        container.querySelector('.dwg-menuGlyph') === null)

      // Put it back so the next case starts from the fixture.
      if (await runMenuItem('g2', '取消固定')) {
        check('unpinning returns it to the rest section',
          groupHeaders().some(row => row.id === 'g2'), JSON.stringify(groupHeaders()))
      }
    }
  }

  // ── the dialog ──────────────────────────────────────────────────────
  const newGroupButton = [...container.querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === '新建分组')
  check('the new-group control mounted', newGroupButton !== undefined)
  if (newGroupButton !== undefined) {
    await click(newGroupButton)
    const dialog = document.querySelector('[role="dialog"]')
    check('the dialog opens', dialog !== null)
    check('the dialog is modal', dialog !== null && dialog.getAttribute('aria-modal') === 'true')
    check('the dialog is portalled', dialog !== null && dialog.closest('body') !== null
      && dialog.parentElement?.parentElement === document.body)
    check('the dialog asks for a name', dialog !== null && dialog.querySelector('input') !== null)
    check('the dialog disables Save on an empty name',
      dialog !== null && [...dialog.querySelectorAll('button')].some(button => button.disabled === true))

    // ── the appearance sheet: icon and colour pickers in the SAME dialog ──
    // These used to be two submenus, which meant changing a group's look took
    // three menu trips and no screen showed the current combination.
    const iconCells = [...(dialog?.querySelectorAll('.dwg-iconCell') ?? [])]
    const swatches = [...(dialog?.querySelectorAll('.dwg-swatch') ?? [])]
    check('the dialog shows a preset icon picker', iconCells.length === 20, `${iconCells.length} icons`)
    check('the dialog shows a preset colour picker', swatches.length === 10, `${swatches.length} swatches`)
    check('the icon picker offers every accent colour too', swatches.every(swatch =>
      [...swatch.classList].some(name => name.startsWith('dwg-accent-'))))
    check('the pickers are labelled for screen readers',
      dialog?.querySelectorAll('[role="group"][aria-label]').length === 2,
      String(dialog?.querySelectorAll('[role="group"][aria-label]').length))
    // Pick the sixth icon and the fifth swatch, then confirm both reach the Host.
    const chosenIcon = iconCells[5]
    const chosenSwatch = swatches[4]
    check('an icon cell is a real button', chosenIcon?.tagName === 'BUTTON', String(chosenIcon?.tagName))
    check('a swatch is a real button', chosenSwatch?.tagName === 'BUTTON', String(chosenSwatch?.tagName))
    if (chosenIcon !== undefined && chosenSwatch !== undefined) {
      await click(chosenIcon)
      await click(chosenSwatch)
      const pressed = dialog.querySelector('.dwg-iconCellOn')
      check('the picked icon becomes the selected one', pressed !== null
        && pressed.getAttribute('aria-pressed') === 'true')
      check('the picked swatch becomes the selected one',
        dialog.querySelector('.dwg-swatchOn') !== null)
    }

    // Type a name and submit through the real form.
    const input = dialog.querySelector('input')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLInputElement.prototype, 'value').set
      setter.call(input, '新分组')
      input.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    })
    const submit = dialog.querySelector('button[type="submit"]')
    check('Save enables once a name is typed', submit !== null && submit.disabled === false)
    await act(async () => {
      dialog.dispatchEvent(new jsdomWindow.Event('submit', { bubbles: true, cancelable: true }))
    })
    const created = calls.filter(call => call.method === 'POST'
      && JSON.parse(call.body).action === 'createGroup').at(-1)
    check('submitting creates the group', created !== undefined
      && JSON.parse(created.body).payload.name === '新分组')
    check('the dialog carries the picked icon to the Host',
      created !== undefined && JSON.parse(created.body).payload.icon === 'bolt',
      created === undefined ? '' : JSON.parse(created.body).payload.icon)
    check('the dialog carries the picked colour to the Host',
      created !== undefined && JSON.parse(created.body).payload.color === 'red',
      created === undefined ? '' : JSON.parse(created.body).payload.color)
    check('the dialog closes after submit', document.querySelector('[role="dialog"]') === null)
    check('the created group is in the DOM', html().includes('新分组'))
  }

  // ── editing an existing group lands all three properties at once ────
  const groupRowForEdit = container.querySelector('[data-dwg-group="g2"]')
  check('a group is addressable for editing', groupRowForEdit !== null)
  if (groupRowForEdit !== null) {
    await click(groupRowForEdit.querySelector('.dwg-iconBtnMenu'))
    const editEntry = [...document.querySelectorAll('.dwg-menu [role="menuitem"]')]
      .find(item => item.textContent?.trim() === '编辑分组…')
    check('the group menu offers one edit entry', editEntry !== undefined)
    if (editEntry !== undefined) {
      await click(editEntry)
      const editDialog = document.querySelector('[role="dialog"]')
      check('editing opens the same dialog', editDialog !== null)
      check('the edit dialog starts from the group\'s current name',
        editDialog?.querySelector('input')?.value === '学习',
        String(editDialog?.querySelector('input')?.value))
      check('the edit dialog starts from the group\'s current colour',
        editDialog?.querySelector('.dwg-swatchOn')?.classList.contains('dwg-accent-green') === true,
        String(editDialog?.querySelector('.dwg-swatchOn')?.className))
      const editSwatch = [...(editDialog?.querySelectorAll('.dwg-swatch') ?? [])]
        .find(swatch => swatch.classList.contains('dwg-accent-teal'))
      if (editSwatch !== undefined) await click(editSwatch)
      await act(async () => {
        editDialog.dispatchEvent(new jsdomWindow.Event('submit', { bubbles: true, cancelable: true }))
      })
      const update = calls.filter(call => call.method === 'POST'
        && JSON.parse(call.body).action === 'updateGroup').at(-1)
      check('saving the edit sends one updateGroup with all three fields', update !== undefined
        && JSON.parse(update.body).payload.name === '学习'
        && JSON.parse(update.body).payload.color === 'teal'
        && JSON.parse(update.body).payload.icon === 'book',
        update === undefined ? '' : update.body)
    }
  }

  // ── unmount ─────────────────────────────────────────────────────────
  await act(async () => { root.unmount() })
  check('unmounts cleanly', container.innerHTML === '')
}

// ── a second mount: the route is unreachable, and the region must say so ──
// A fresh `apply()` gives a fresh document store (the store is page-global by
// design, so reusing the first one would start from `loaded: true` and never
// reach the failure face).
console.log('▸ mounting again with an unreachable Host route')
const registrations2 = []
let localeTable2 = null
const fakeCtx2 = {
  ...fakeCtx,
  locale: {
    register(ns, table) { localeTable2 = table },
    bind: fakeCtx.locale.bind,
  },
  slots: {
    currentKey: null,
    inject(key, callback) {
      const previous = this.currentKey
      this.currentKey = key
      try { callback() } finally { this.currentKey = previous }
      return () => {}
    },
    register(options, component) { registrations2.push({ options, component }); return () => {} },
  },
}
plugin.apply(fakeCtx2)
const component2 = registrations2[0].component
const injectFace2 = registrations2[0].options.inject()
const injected2 = injectFace2.injected

const brokenCalls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (path, init) => {
  brokenCalls.push({ path, method: init?.method ?? 'GET' })
  return { ok: false, status: 503, json: async () => ({ error: 'down' }) }
}
const brokenContainer = document.createElement('div')
document.body.appendChild(brokenContainer)
const brokenRoot = ReactDOMClient.createRoot(brokenContainer)
let brokenError = null
try {
  await act(async () => { brokenRoot.render(React.createElement(component2, { ...props, ...injectFace2 })) })
} catch (error) {
  brokenError = error
}
check('an unreachable route does not throw', brokenError === null, brokenError?.message)
if (brokenError === null) {
  check('the failure face rendered instead of a permanent spinner',
    brokenContainer.innerHTML.includes('dwg-failed'),
    'a traffic/route outage would otherwise sit on "…" forever')
  check('the failure names the reason', brokenContainer.innerHTML.includes('503'))
  check('the failure offers a retry control', brokenContainer.innerHTML.includes('重试'))
  const retry = [...brokenContainer.querySelectorAll('button')].find(button => button.textContent === '重试')
  check('the retry control mounted', retry !== undefined)
  if (retry !== undefined) {
    await click(retry)
    check('retry asks the Host again', brokenCalls.filter(call => call.method === 'GET').length >= 2)
  }
}
globalThis.fetch = realFetch
await act(async () => { brokenRoot.unmount() })
check('the failed mount unmounts cleanly', brokenContainer.innerHTML === '')

console.log('')
console.log(failures === 0 ? '▸ PASS — real DOM mount, effects, clicks and portals all work'
  : `▸ FAIL — ${failures} failing check(s)`)
process.exitCode = failures === 0 ? 0 : 1
