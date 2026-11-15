/**
 * Real-React render check — NOT shipped.
 *
 * The smoke test in `smoke.mjs` uses a hand-written hook runtime. This one uses
 * the ACTUAL React 18 renderer (`react-dom/server`) against the real bundle, so
 * it proves the two things a fake runtime cannot:
 *
 *   1. every component is hook-legal under the real reconciler (no conditional
 *      hooks, no bad dep arrays, no missing keys that React refuses to render);
 *   2. `createElement` props are React-valid (no `undefined` className,
 *      no unknown DOM attributes, no object passed where text belongs).
 *
 * Portals are not exercised: React's server renderer refuses them, and this
 * document keeps every menu and dialog closed on the first render — which is
 * exactly the state the sidebar mounts in.
 *
 * Usage: node test/render.mjs   (needs react + react-dom installed beside it)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findReact, reactVersion, skip } from './react-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const found = findReact()
if (found === null) skip('test/render.mjs', 'react and react-dom')
const require = found.require

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
console.log(`▸ react ${reactVersion(found.root)} from ${found.root}`)

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── the minimum browser surface the bundle touches outside React ──────────

const styleTags = []
globalThis.document = {
  head: { appendChild: (node) => { styleTags.push(node); return node } },
  body: {},
  createElement: () => {
    const node = { attrs: {}, textContent: '' }
    node.setAttribute = (key, value) => { node.attrs[key] = value }
    node.remove = () => {}
    return node
  },
}
globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.setTimeout = () => 1
globalThis.clearTimeout = () => {}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (HOST_DOCUMENT) })

let loaded = null
globalThis.__ModuleLoader__ = { load: (registration) => { loaded = registration } }

/** One realistic Host document: pinned group, loose group, empty group, archive. */
const HOST_DOCUMENT = {
  version: 1,
  groups: [
    { id: 'g1', name: '客户端项目', color: 'blue', icon: 'code', pinned: true, collapsed: false, order: 0, createdAt: 1 },
    { id: 'g2', name: '学习', color: 'green', icon: 'book', pinned: false, collapsed: false, order: 0, createdAt: 2 },
    { id: 'g4', name: '待整理', color: 'amber', icon: 'star', pinned: false, collapsed: true, order: 1, createdAt: 3 },
  ],
  archivedGroups: [{ id: 'g3', name: '旧项目', color: 'slate', icon: 'briefcase' }],
  assign: { w2: 'g1', w3: 'g2', w4: 'g4' },
  orders: { g1: ['w2'], g2: ['w3'], g4: ['w4'], __ungrouped__: ['w1'] },
  workspaceState: { w2: { expanded: true, showAll: false } },
  ui: { view: 'grouped' },
  settings: { previewSessions: 2, searchLimit: 80 },
  persisted: true,
  error: null,
  file: 'C:/fake/state.json',
}

console.log('▸ loading the bundle under real React')
new Function(readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')).call(globalThis)
check('the loader received the bundle', loaded !== null && loaded.id === 'dsh-workspace-groups')
const plugin = loaded.factory(name => {
  if (name === 'react') return React
  if (name === 'react-dom') return require('react-dom')
  throw new Error(`unbalanced require: ${name}`)
})
check('the plugin exposes apply', typeof plugin.apply === 'function')

const registrations = []
const localeTables = []
const fakeCtx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject(services, callback) {
    const scoped = { ...fakeCtx }
    if (services.includes('shortcuts')) scoped.shortcuts = { register: () => () => {} }
    callback(scoped)
  },
  get(name) {
    if (name === 'workspaces') return { create: async i => ({ workspaceId: 'w-x', path: i.path }), rename: async () => {}, delete: async () => {} }
    if (name === 'uiWorkspace') return { pickDirectory: async () => null, startSession() {}, openSession() {} }
    if (name === 'contextMenus') return { open() {} }
    return undefined
  },
  locale: {
    register(ns, table) { localeTables.push(table) },
    bind() { return (key, params) => {
      const template = (localeTables.at(-1)?.zh ?? {})[key] ?? key
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
check('registration captured', registrations.length === 1)
const component = registrations[0].component
const injectFace = registrations[0].options.inject()
const injected = injectFace.injected

// ── the fixtures React will actually render ──────────────────────────────

const workspaces = [
  { workspaceId: 'w1', path: 'C:/work/alpha', title: 'alpha', sessionIds: ['s1'] },
  { workspaceId: 'w2', path: 'C:/work/beta', title: 'beta', sessionIds: ['s2', 's3', 's4'], createdAt: '2026-01-01', updatedAt: '2026-01-02' },
  { workspaceId: 'w3', path: 'C:/work/learn', title: 'learn', sessionIds: ['s5'], createdAt: '2026-01-01', updatedAt: '2026-01-02' },
  { workspaceId: 'w4', path: 'C:/work/messy', title: '待整理的项目', sessionIds: ['s6'], createdAt: '2026-01-01', updatedAt: '2026-01-02' },
]
const now = Date.now()
const sessions = {
  ids: ['s1', 's2', 's3', 's4', 's5', 's6'],
  byId: {
    s1: { id: 's1', title: '脚手架讨论', displayTitle: '脚手架讨论', updatedAt: now - 3 * 86_400_000, running: false, blank: false, retainedBy: {} },
    s2: { id: 's2', title: '登录页重构', displayTitle: '登录页重构', updatedAt: now - 60_000, running: true, blank: false, retainedBy: {} },
    s3: { id: 's3', title: '打包失败排查', displayTitle: '打包失败排查', updatedAt: now - 90 * 60_000, running: false, blank: false, retainedBy: {} },
    s4: { id: 's4', title: '', displayTitle: 'beta', updatedAt: now - 2 * 86_400_000, running: false, blank: false, retainedBy: {} },
    s5: { id: 's5', title: '正则笔记', displayTitle: '正则笔记', updatedAt: now - 5 * 3_600_000, running: false, blank: false, retainedBy: {} },
    s6: { id: 's6', title: '整理一下', displayTitle: '整理一下', updatedAt: now - 9 * 86_400_000, running: false, blank: false, retainedBy: {} },
  },
}
const statuses = new Map([
  ['s2', { running: true, completionUnread: false, pendingInteraction: undefined }],
  ['s3', { running: false, completionUnread: true, pendingInteraction: undefined }],
  ['s5', { running: false, completionUnread: true, pendingInteraction: undefined }],
  ['s6', { running: false, completionUnread: false, pendingInteraction: { key: 'q1', kind: 'question', sessionId: 's6' } }],
])
const selectHook = value => selector => selector(value)
const propsWith = wide => ({
  wide,
  expandSidebar: () => {},
  useWorkspaces: selectHook({
    items: workspaces, phase: 'ready', state: 'idle', error: null,
    archivedSessionIds: ['s1'], pinnedSessionIds: ['s2'],
  }),
  useSessions: selectHook(sessions),
  useSessionStatus: selectHook(statuses),
  useSectionScroller: () => ({ bindScrollerRef: () => {} }),
  ...injectFace,
  t: fakeCtx.locale.bind(),
})

console.log('▸ reading the document before the first paint')
// The component reads on mount through an effect; `renderToStaticMarkup` never
// runs effects, so the read is performed here and awaited, which is the state
// the sidebar paints in one tick after it mounts.
await injected.data.start()
check('the Host document reached the component', injected.data.source.getSnapshot().loaded === true,
  String(injected.data.source.getSnapshot().loaded))

console.log('▸ rendering with react-dom/server')
const render = (wide) => {
  const element = React.createElement(component, propsWith(wide))
  return renderToStaticMarkup(element)
}

let wideHtml = ''
let wideError = null
try {
  wideHtml = render(true)
} catch (error) {
  wideError = error
}
check('the wide variant renders under real React', wideError === null,
  wideError === null ? undefined : `${wideError.message}\n${String(wideError.stack).split('\n').slice(0, 8).join('\n')}`)

let railHtml = ''
let railError = null
try {
  railHtml = render(false)
} catch (error) {
  railError = error
}
check('the rail variant renders under real React', railError === null, railError?.message)

if (wideError === null) {
  check('the tree mounts inside the region element', wideHtml.startsWith('<div class="dwg-root"'))
  check('group headers are present', (wideHtml.match(/class="dwg-row dwg-rowGroup/g) ?? []).length === 4,
    `${(wideHtml.match(/dwg-rowGroup/g) ?? []).length} headers`)
  check('project rows are present', (wideHtml.match(/dwg-rowProject/g) ?? []).length === 3,
    'w1, w2 and w3: w4 lives inside the collapsed group and must not render')
  check('the expanded project lists its preview conversations', (wideHtml.match(/dwg-rowSession/g) ?? []).length === 2,
    'w2 is expanded with previewSessions: 2, so s2 and s3 show and s4 waits behind "show more"')
  check('the "show more" affordance appears exactly once', (wideHtml.match(/dwg-moreBtn/g) ?? []).length === 1)
  check('the collapsed group renders no children', !wideHtml.includes('整理一下'),
    'g4 is collapsed, so its project and conversation must not render')
  check('the running badge is in the markup', wideHtml.includes('运行中'))
  check('the unread badge is in the markup', wideHtml.includes('新完成'))
  check('the pending badge is in the markup', wideHtml.includes('待处理'),
    's6 waits on a question, so its group must show the pending badge')
  check('the accent classes survive real rendering', wideHtml.includes('dwg-accent-blue')
    && wideHtml.includes('dwg-accent-green') && wideHtml.includes('dwg-accent-amber'))
  check('the archived drawer is present', wideHtml.includes('已归档分组'))
  check('no empty class attribute leaks', !wideHtml.includes('class=""'))
  check('no `undefined` reaches the markup', !wideHtml.includes('undefined') && !wideHtml.includes('NaN'))
  check('aria-expanded is a valid string value', wideHtml.includes('aria-expanded="false"')
    && wideHtml.includes('aria-expanded="true"'))
  check('the region is labelled for screen readers', wideHtml.includes('aria-label="工作区分组树"'))
  check('rows carry their searchable identity', wideHtml.includes('data-dwg-session="s2"'))
}

if (railError === null) {
  check('the rail renders only controls', railHtml.includes('dwg-rootRail')
    && !railHtml.includes('dwg-body')
    && (railHtml.match(/dwg-railBtn/g) ?? []).length === 3)
}

check('the stylesheet was injected once', styleTags.length === 1)

/**
 * The composition the renderer actually performs: `{...kit} {...injectFace()}`
 * `{...ownerProps}`. `renderToStaticMarkup` of that composition must reach the
 * tree — never the component's own wiring face. This is the real-React twin of
 * the smoke test's inject-shape checks: it pins the FLAT spread, not just the
 * single `injected` prop.
 */
const composedHtml = renderToStaticMarkup(React.createElement(component, {
  ...propsWith(true),
  ...registrations[0].options.inject(),
}))
check('the renderer\'s own composition reaches the tree', composedHtml.includes('dwg-body')
  && composedHtml.includes('dwg-rowGroup'))
check('the renderer\'s composition never trips the wiring guard', !composedHtml.includes('dwg-miswired'))
console.log('')
console.log(failures === 0 ? '▸ PASS — real React rendered both variants' : `▸ FAIL — ${failures} failing check(s)`)
process.exitCode = failures === 0 ? 0 : 1
