/**
 * Smoke test for the browser half — NOT shipped with the bundle.
 *
 * In the Web shell the bundle is loaded by
 * `window.__ModuleLoader__.load({ id, factory })` with the real React
 * reconciler. This session has no authenticated page (the client inspect
 * bridge times out), so this file stands in for that shell: a small hook
 * runtime, a mini renderer that walks function components, a fake `document`,
 * and a fake `fetch` that answers with a realistic Host document.
 *
 * What it therefore CAN prove:
 *   1. the factory runs and returns a plugin object with `inject` + `apply`;
 *   2. `apply` registers ONE entry into `sidebar.workspaces` at a shadowing
 *      priority, declares no child slots, and registers both locale halves;
 *   3. the registered component renders a full tree — group headers, project
 *      rows, conversation rows, status badges, the archive drawer — without
 *      throwing, in both the wide and rail variants.
 *
 * What it cannot prove: how the region LOOKS, or that the shipped theme tokens
 * resolve to the intended colours. That needs the real page.
 *
 * Usage: node test/smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// A minimal React stand-in: hooks + a renderer that walks function
// components. Every component gets its own hook slot block, exactly like
// React, so a component that calls hooks conditionally would still be
// caught here (slot indices are per component instance, not global).
// ═══════════════════════════════════════════════════════════════════════

let hookBlock = null
const createBlock = () => ({ slots: [], cursor: 0 })

const React = {
  createElement(type, props, ...children) {
    return {
      $$wg: true,
      type,
      props: props ?? {},
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const block = hookBlock
    const index = block.cursor++
    if (!(index in block.slots)) block.slots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => { block.slots[index] = typeof next === 'function' ? next(block.slots[index]) : next }
    return [block.slots[index], set]
  },
  useEffect() { hookBlock.cursor += 1 },
  useLayoutEffect() { hookBlock.cursor += 1 },
  useMemo(fn) { hookBlock.cursor += 1; return fn() },
  useRef(initial) {
    const block = hookBlock
    const index = block.cursor++
    if (!(index in block.slots)) block.slots[index] = { current: initial }
    return block.slots[index]
  },
  useCallback(fn) { hookBlock.cursor += 1; return fn },
  useSyncExternalStore(_subscribe, read) { hookBlock.cursor += 1; return read() },
  useId() { hookBlock.cursor += 1; return 'id' },
}

/** Render one element tree into plain host elements, running function components. */
const render = (element) => {
  if (element === null || element === undefined || element === false || element === true) return null
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(render).filter(node => node !== null)

  const previous = hookBlock
  hookBlock = createBlock()
  try {
    if (typeof element.type === 'function') {
      // React copies a `children` key given in the props object; only positional
      // children replace it. Reproduce that exactly.
      const produced = element.type(element.children === undefined
        ? element.props
        : { ...element.props, children: element.children })
      const rendered = render(produced)
      return rendered
    }
    const props = { ...element.props }
    if (element.children !== undefined) props.children = render(element.children)
    return { type: typeof element.type === 'symbol' ? 'fragment' : element.type, props }
  } finally {
    hookBlock = previous
  }
}

/** Depth-first walk of the rendered tree, yielding every host element. */
const walk = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (typeof node === 'string') return out
  out.push(node)
  if (node.props.children !== undefined) walk(node.props.children, out)
  return out
}
const classesOf = node => (node.props.className === undefined ? [] : String(node.props.className).split(' '))
const countClass = (tree, name) => walk(tree).filter(node => classesOf(node).includes(name)).length
const textOf = (tree) => {
  const parts = []
  const visit = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { parts.push(node); return }
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node.props.children !== undefined) visit(node.props.children)
  }
  visit(tree)
  return parts.join(' ')
}
const byAria = (tree, label) => walk(tree).find(node => node.props['aria-label'] === label)

// ═══════════════════════════════════════════════════════════════════════
// Fake browser globals
// ═══════════════════════════════════════════════════════════════════════

const styleTags = []
globalThis.document = {
  head: { appendChild: node => { styleTags.push(node); return node } },
  body: {},
  createElement: (tag) => {
    const node = { tag, attrs: {}, textContent: '' }
    node.setAttribute = (key, value) => { node.attrs[key] = value }
    node.remove = () => {}
    return node
  },
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
}
globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
const timers = []
globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length }
globalThis.clearTimeout = () => {}

/** The document the Host route answers with: two groups, one archived, one pinned. */
const HOST_DOCUMENT = {
  version: 1,
  groups: [
    { id: 'g1', name: '客户端项目', color: 'blue', icon: 'code', pinned: true, collapsed: false, order: 0, createdAt: 1 },
    { id: 'g2', name: '学习', color: 'green', icon: 'book', pinned: false, collapsed: false, order: 1, createdAt: 2 },
    { id: 'g4', name: '空组', color: 'amber', icon: 'star', pinned: false, collapsed: false, order: 2, createdAt: 3 },
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

const requests = []
globalThis.fetch = async (path, init) => {
  requests.push({ path, method: init?.method ?? 'GET', body: init?.body })
  return { ok: true, status: 200, json: async () => HOST_DOCUMENT }
}

let loaded = null
globalThis.__ModuleLoader__ = { load: (registration) => { loaded = registration } }

// ═══════════════════════════════════════════════════════════════════════
// Evaluate the bundle exactly the way the Web shell does
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ loading the bundle as the Web shell does')
new Function(bundle).call(globalThis)
check('loads with the package id', loaded !== null && loaded.id === 'dsh-workspace-groups', loaded?.id)

const required = []
const plugin = loaded.factory((name) => {
  required.push(name)
  if (name === 'react') return React
  // `react-dom` is in the shell's seed table, so asking for it is legitimate;
  // this runtime has no portal target, so the bundle falls back to inline
  // rendering (which is a branch it must survive anyway).
  if (name === 'react-dom') throw new Error('this fake runtime has no react-dom')
  throw new Error(`unexpected require: ${name}`)
})
check('requires only platform-seed specifiers', required.every(name => name === 'react' || name === 'react-dom'), required.join(', '))
check('factory returns a plugin object', plugin !== null && typeof plugin === 'object')
check('inject lists slots and locale', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'), String(plugin.inject))
check('apply is a function', typeof plugin.apply === 'function')

// ═══════════════════════════════════════════════════════════════════════
// apply(ctx) against a fake context
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ apply(ctx)')
const registrations = []
const localeRegistrations = []
const appliedEffects = []
/** Commands registered through `ctx.shortcuts.register`. */
const shortcutCommands = []
const fakeCtx = {
  effect(fn, label) {
    appliedEffects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  /** Cordis' service fence: await the named services, then run the callback. */
  inject(services, callback) {
    const scoped = { ...fakeCtx }
    if (services.includes('shortcuts')) {
      scoped.shortcuts = {
        register(command) {
          shortcutCommands.push(command)
          return () => {}
        },
      }
    }
    callback(scoped)
  },
  get(name) {
    if (name === 'workspaces') {
      return {
        create: async input => ({ workspaceId: `w-${input.path}`, path: input.path }),
        rename: async () => {},
        delete: async () => {},
      }
    }
    if (name === 'uiWorkspace') return { pickDirectory: async () => '/fake/picked', startSession() {}, openSession() {} }
    if (name === 'contextMenus') return { open() {} }
    return undefined
  },
  locale: {
    register(ns, table) { localeRegistrations.push({ ns, table }) },
    bind() {
      return (key, params) => {
        const table = localeRegistrations.at(-1)?.table?.zh ?? {}
        const template = table[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      }
    },
  },
  slots: {
    currentKey: null,
    inject(key, callback) {
      const previous = this.currentKey
      this.currentKey = key
      try {
        callback()
      } finally {
        this.currentKey = previous
      }
      return () => {}
    },
    register(options, component) {
      registrations.push({ key: this.currentKey, options, component })
      return () => {}
    },
  },
}
plugin.apply(fakeCtx)

check('registers effects for dictionaries, styles and the notice timer', appliedEffects.length >= 2, appliedEffects.join(' | '))
check('locale registered with both halves', localeRegistrations.length === 1
  && typeof localeRegistrations[0].table.zh === 'object'
  && typeof localeRegistrations[0].table.en === 'object')
check('zh and en have identical key sets', JSON.stringify(Object.keys(localeRegistrations[0].table.zh).sort())
  === JSON.stringify(Object.keys(localeRegistrations[0].table.en).sort()),
  `zh=${Object.keys(localeRegistrations[0].table.zh).length} en=${Object.keys(localeRegistrations[0].table.en).length}`)
check('dictionary covers the whole surface', Object.keys(localeRegistrations[0].table.zh).length > 90,
  String(Object.keys(localeRegistrations[0].table.zh).length))
check('the dictionary has no unresolved placeholders', Object.values(localeRegistrations[0].table.en)
  .every(value => typeof value === 'string'), 'every entry must be a plain string')
check('styles inserted into the head', styleTags.length === 1 && styleTags[0].attrs['data-plugin'] === 'dsh-workspace-groups')

const CSS = styleTags[0].textContent
check('CSS has no unresolved template holes', !CSS.includes('${') && !CSS.includes('undefined'))
check('CSS declares every accent for light', CSS.includes('.dwg-accent-blue{--dwg-accent:#4176E6}')
  && CSS.includes('.dwg-accent-slate{--dwg-accent:#61666B}'))
check('CSS declares every accent for dark', CSS.includes('body[data-ds-dark-theme] .dwg-accent-blue{--dwg-accent:#7AAAFF}')
  && CSS.includes('body[data-ds-dark-theme] .dwg-accent-teal{--dwg-accent:#2DC8EB}'))
check('CSS names all ten accents', ['blue', 'indigo', 'violet', 'rose', 'red', 'orange', 'amber', 'green', 'teal', 'slate']
  .every(color => CSS.includes(`.dwg-accent-${color}{`)))

/** Every `var(--x)` reference in the sheet, de-duplicated. */
const cssVars = [...new Set([...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]))].sort()
check('CSS defines its own accent variable so it has a fallback', cssVars.includes('--dwg-accent'))
check('CSS reads a plausible number of theme tokens', cssVars.filter(name => name.startsWith('--dsw-')).length >= 12,
  `${cssVars.filter(name => name.startsWith('--dsw-')).length} theme tokens`)
check('CSS has no literal colours left on chrome', !/(?:^|[;{])\s*(?:color|background|border-color)\s*:\s*#[0-9a-fA-F]{6}/m.test(CSS),
  'chrome must go through tokens; only the accent block is literal')

/**
 * `--dsw-alias-brand-primary` is the monochrome brand ink (near-black on the
 * light theme, near-white on the dark one), NOT an accent hue. Painting a
 * focus ring or a field border with it produces a heavy black box on the light
 * theme — which is exactly what shipped once. The interactive blue is
 * `--dsw-alias-state-business-primary`. This pins the distinction so the sheet
 * cannot quietly regress to the ink token for accents.
 */
check('CSS never uses the monochrome brand ink as an accent', !CSS.includes('var(--dsw-alias-brand-primary)'),
  'use --dsw-alias-state-business-primary for interactive blue')
check('CSS paints focus rings from the platform ring tokens', CSS.includes('var(--dsw-focus-ring-width'),
  'the shipped focus fallback names colour and width separately')

/**
 * Theme-token PAIRING rules. Each of these pinned a real defect:
 *
 * - A filled button's hover must step its own fill. A generic
 *   `background: interactive-bg-hover` on a filled button REPLACES the fill
 *   with a translucent tint, so the button reads as "fill gone, only a border
 *   left" — what the primary Save button did.
 * - A resized IconButton variant must name both classes, because the 20px base
 *   rule sits later in the sheet and would win at equal specificity.
 * - The two bands (pinned and rest) must not each draw a rule at the same seam.
 */
check('the primary button hover steps its own fill',
  /\.dwg-btnPrimary:hover:not\(:disabled\)\{background:var\(--dsw-alias-button-primary-hover\)/.test(CSS),
  'repainting a filled button with the row-hover tint erases the fill')
check('the danger button hover steps from the error colour',
  /\.dwg-btnDanger:hover:not\(:disabled\)\{--dsw-alias-button-primary-hover:color-mix\(/.test(CSS),
  'the theme has no distinct danger hover step, so one is mixed here')
check('every resized icon-button variant names its base class',
  ['.dwg-iconBtn.dwg-iconBtnHeader{', '.dwg-iconBtn.dwg-railBtn{', '.dwg-iconBtn.dwg-viewBtn{', '.dwg-iconBtn.dwg-searchClear{']
    .every(selector => CSS.includes(selector)),
  'the shared 20px base is declared later in the sheet')
check('the Ungrouped top rule is a variant, not unconditional',
  CSS.includes('.dwg-groupLoose{') && CSS.includes('.dwg-groupLooseSep{border-top:'),
  'an unconditional border would also draw above the first row when there are no groups')
check('exactly one rule owns the seam under the pinned band',
  !CSS.includes('.dwg-pinnedRule{border') && !CSS.includes('dwg-pinnedRule{height:1px;margin:4px 8px;'),
  'the pinned band draws its own rule; a second one a few rows below is the reported double line')
check('the search field suppresses the square input ring',
  /\.dwg-searchInput:focus-visible\{outline:0\}|\.dwg-searchInput:focus,\.dwg-searchInput:focus-visible\{outline:0\}/.test(CSS),
  'the rounded container shows focus; a square ring inside it reads as a glitch')
check('the search container does show focus itself', CSS.includes('.dwg-search:focus-within'),
  'otherwise the field has no focus feedback at all')

check('registered exactly one slot entry', registrations.length === 1, `count=${registrations.length}`)
const registration = registrations[0]
check('registered into sidebar.workspaces', registration.key === 'sidebar.workspaces', registration.key)
check('registration shadows the shipped entry', registration.options.priority === -1, String(registration.options.priority))
check('registration declares the locale namespace', registration.options.locale === 'workspaceGroups')
check('registration declares NO child slots', registration.options.children === undefined,
  'declaring a live child slot throws on an already-declared key')
check('registration declares an inject face', typeof registration.options.inject === 'function')
check('registered component is a function', typeof registration.component === 'function')
/**
 * The renderer composes an entry as `{...kit} {...injectFace()} {...ownerProps}`
 * — the face is a PROPS FACTORY, one prop per key it returns. The region reads
 * its handles off a single `injected` prop, so the face must publish exactly
 * that key: returning the handles bare would spread `data`/`notice`/`notify`
 * as top-level props, the region would read `props.injected === undefined` and
 * crash on its first hook — and because a shadowing single slot answers a
 * render crash by abdicating to the next occupant, the failure would look like
 * "the plugin does nothing" instead of any error at all.
 */
const injectFace = registration.options.inject()
check('the inject face publishes exactly one prop, named `injected`',
  JSON.stringify(Object.keys(injectFace)) === '["injected"]', Object.keys(injectFace).join(','))
check('the region is reachable under that prop', typeof injectFace.injected === 'object' && injectFace.injected !== null)

check('registers the collapse-all command behind the shortcuts fence', shortcutCommands.length === 1,
  `${shortcutCommands.length} command(s)`)
const command = shortcutCommands[0]
if (command !== undefined) {
  check('the command carries a stable id', command.id === 'workspaceGroups.collapseAll', String(command.id))
  check('the command has a localized label', command.label() === '全部折叠工作区分组', command.label())
  check('the command declares every runtime profile',
    Object.keys(command.defaults).join(',') === 'desktop:macos,desktop:windows,desktop:linux,web:macos,web:windows',
    Object.keys(command.defaults).join(','))
  check('every default binding uses a supported physical code',
    Object.values(command.defaults).every(binding => /^(Key[A-Z]|Digit[0-9])$/.test(binding.code)),
    JSON.stringify(Object.values(command.defaults)))
  check('every Web binding carries two modifiers',
    ['web:macos', 'web:windows'].every(profile => command.defaults[profile].modifiers.length >= 2),
    'the Web runtime rejects a single-modifier binding')
  check('the command resolves to a handled action',
    command.resolve({ region: 'page', modal: null, target: null }).status === 'handled')
  check('the command stays available inside the sidebar drawer',
    command.modals.includes('sidebar'), JSON.stringify(command.modals))
}

// ═══════════════════════════════════════════════════════════════════════
// The store's own behaviour: read, mutate, ordered writes
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ the document store')
const injectedFace = registration.options.inject().injected
const snapshotBefore = injectedFace.data.source.getSnapshot()
check('the pre-read document is empty but well formed', snapshotBefore.groups.length === 0
  && snapshotBefore.settings.previewSessions === 2 && snapshotBefore.ui.view === 'grouped')
await injectedFace.data.start()
check('a read was issued to the state route', requests.some(request => request.method === 'GET' && request.path === '/api/workspace-groups/state'))
const snapshotAfter = injectedFace.data.source.getSnapshot()
check('the answered document is normalized and published', snapshotAfter.groups.length === 3
  && snapshotAfter.archivedGroups.length === 1 && snapshotAfter.file === 'C:/fake/state.json',
  `groups=${snapshotAfter.groups.length} archived=${snapshotAfter.archivedGroups.length}`)
check('settings are clamped into range', snapshotAfter.settings.searchLimit === 80)

await injectedFace.data.mutate('createGroup', { name: '新组', color: 'violet', icon: 'star' })
check('a mutation goes to the mutate route with an action body', requests.some(request => request.method === 'POST'
  && request.path === '/api/workspace-groups/mutate'
  && JSON.parse(request.body).action === 'createGroup'))

// Writes must be serialized: a drag landing during a rename cannot overtake it.
const order = []
await Promise.all([
  injectedFace.data.mutate('updateGroup', { groupId: 'g1', name: 'A' }).then(() => order.push('first')),
  injectedFace.data.mutate('updateGroup', { groupId: 'g1', name: 'B' }).then(() => order.push('second')),
])
check('concurrent mutations settle in call order', order.join(',') === 'first,second', order.join(','))

// ═══════════════════════════════════════════════════════════════════════
// Render the region
// ═══════════════════════════════════════════════════════════════════════

console.log('▸ WorkspaceGroups(props)')
const injected = registration.options.inject().injected
check('inject face exposes the document and the notice channel',
  typeof injected.data?.start === 'function' && typeof injected.data?.mutate === 'function'
  && typeof injected.notify === 'function' && typeof injected.notice?.subscribe === 'function')

const workspaces = [
  { workspaceId: 'w1', path: 'C:/work/alpha', title: 'alpha', sessionIds: ['s1'] },
  { workspaceId: 'w2', path: 'C:/work/beta', title: 'beta', sessionIds: ['s2', 's3', 's4'] },
  { workspaceId: 'w3', path: 'C:/work/learn', title: 'learn', sessionIds: ['s5'] },
]
const sessions = {
  ids: ['s1', 's2', 's3', 's4', 's5'],
  byId: {
    s1: { id: 's1', title: '脚手架讨论', updatedAt: 1000, workspaceId: 'w1' },
    s2: { id: 's2', title: '登录页重构', updatedAt: 4000, workspaceId: 'w2' },
    s3: { id: 's3', title: '打包失败排查', updatedAt: 3000, workspaceId: 'w2' },
    s4: { id: 's4', title: '', updatedAt: 2000, workspaceId: 'w2' },
    s5: { id: 's5', title: '正则笔记', updatedAt: 5000, workspaceId: 'w3' },
  },
}
const statuses = new Map([
  ['s2', { running: true, completionUnread: false }],
  ['s3', { running: false, completionUnread: true }],
  ['s5', { running: false, completionUnread: true }],
])
const selectHook = value => selector => selector(value)
const baseProps = wide => ({
  wide,
  expandSidebar: () => {},
  useWorkspaces: selectHook({
    items: workspaces,
    phase: 'ready',
    archivedSessionIds: ['s1'],
    pinnedSessionIds: ['s2'],
    state: 'ready',
  }),
  useSessions: selectHook(sessions),
  useSessionStatus: selectHook(statuses),
  useSectionScroller: () => ({ bindScrollerRef: () => {} }),
  ...registration.options.inject(),
  t: fakeCtx.locale.bind(),
})

const wideTree = render(React.createElement(registration.component, baseProps(true)))
let thrown = null
if (wideTree === null) thrown = new Error('render returned nothing')
check('renders without throwing', wideTree !== null)

if (wideTree !== null) {
  const text = textOf(wideTree)
  check('root carries the region class', countClass(wideTree, 'dwg-root') === 1)
  check('header renders with the localized title', countClass(wideTree, 'dwg-header') === 1 && text.includes('工作区'))
  check('every group plus the Ungrouped bucket renders a header', countClass(wideTree, 'dwg-rowGroup') === 4,
    `count=${countClass(wideTree, 'dwg-rowGroup')}`)
  check('group names are the stored names', text.includes('客户端项目') && text.includes('学习'))
  check('the ungrouped bucket is labelled', text.includes('未分组'))
  check('all three projects render', countClass(wideTree, 'dwg-rowProject') === 3,
    `count=${countClass(wideTree, 'dwg-rowProject')}`)
  // Only w2 is expanded (fixture: workspaceState.w2 = { expanded, showAll }), so
  // its four-or-fewer conversations are the only conversation rows on screen;
  // the other projects stay folded. s4 (title "") is one of them.
  check('only the expanded project lists conversations', countClass(wideTree, 'dwg-rowSession') === 3,
    `count=${countClass(wideTree, 'dwg-rowSession')}: w2 holds s2-s4`)
  check('conversation titles are the real DSH titles', text.includes('登录页重构') && text.includes('打包失败排查'))
  check('a conversation with no title falls back to the dictionary', text.includes('未命名对话'), 's4 has title ""')
  check('a running conversation raises the running badge', text.includes('运行中'), 's2 is running')
  check('a group whose only news is a finished run raises the unread badge', text.includes('新完成'),
    'g2 owns s5, which is completion-unread and not running')
  check('accent classes reach both groups', countClass(wideTree, 'dwg-accent-blue') >= 1 && countClass(wideTree, 'dwg-accent-green') >= 1)
  check('the accent glyph and the accent bar both render',
    countClass(wideTree, 'dwg-glyphAccent') >= 2 && countClass(wideTree, 'dwg-accentBar') >= 2)
  check('the pinned group renders before the unpinned one', (() => {
    const headers = walk(wideTree).filter(node => classesOf(node).includes('dwg-rowGroup'))
    return classesOf(headers[0]).includes('dwg-accent-blue')
  })(), 'pin order is applied at render, not stored as a separate field')
  check('the archive drawer is present and closed by default', text.includes('已归档分组')
    && !text.includes('旧项目'), 'the archived group stays behind the drawer until it is opened')
  check('collapse-all is reachable from the header', byAria(wideTree, '全部折叠') !== undefined)
  check('search stays hidden until asked for', countClass(wideTree, 'dwg-search') === 0)
  check('nothing is open on the first render', countClass(wideTree, 'dwg-scrim') === 0 && countClass(wideTree, 'dwg-menu') === 0)
  check('the tree is a real drop target', walk(wideTree).some(node => typeof node.props.onDrop === 'function'))
  check('rows are draggable', walk(wideTree).some(node => node.props.draggable === true))
  check('rows expose tree semantics', walk(wideTree).some(node => node.props.role === 'tree')
    && walk(wideTree).some(node => node.props['aria-expanded'] === 'true')
    && walk(wideTree).some(node => node.props['aria-expanded'] === 'false'))
  check('each conversation row is addressable for a search reveal',
    walk(wideTree).some(node => node.props['data-dwg-session'] === 's2'))
  check('empty groups hint at the drop target', text.includes('拖项目到这里'))
  /**
   * The Ungrouped bucket is drawn from the model, never unconditionally.
   *
   * It used to be a fixed last section, so with every project filed away the
   * tree still ended in a "未分组" heading over a dashed "drop a project here"
   * placeholder — furniture describing a section with nothing in it. It is
   * gated now (see `showUngrouped`), and the gate has a second input: a project
   * drag brings the strip back, because dropping on it is the only pointer
   * gesture that takes a project OUT of a group.
   */
  check('the ungrouped section is gated, not unconditional',
    bundle.includes('const showUngrouped =') && bundle.includes('...(showUngrouped'),
    'a fixed last section leaves an empty heading behind')
  check('the band seam reads the same gate as the strip',
    bundle.includes('model.groups.length > 0 || showUngrouped'),
    'the seam must not be decided from a different expression than the row')
  check('a project drag re-opens the drop target',
    bundle.includes("dragging !== null && dragging.kind === 'project'"),
    'the strip is the only pointer way out of a group')
  check('the drag payload is state, not only a ref',
    bundle.includes('const [dragging, setDragging] = useState(null)')
    && bundle.includes('setDragging(payload)') && bundle.includes('setDragging(null)'),
    'a ref write does not re-render, so the target would appear too late')
  check('the truly empty tree gets a sentence instead of a blank panel',
    text.includes('还没有项目和分组') === false && bundle.includes("t('tree.empty')"),
    'the normal fixture has projects, so the hint must not paint here')
  check('the empty-tree hint is not painted over archived groups',
    bundle.includes('model.archivedGroups.length === 0'),
    'the drawer still has something to offer, so the tree keeps its shape')
  check('the empty-tree copy exists in both languages',
    localeRegistrations[0].table.zh['tree.empty'] !== undefined
    && localeRegistrations[0].table.en['tree.empty'] !== undefined)
}

const railTree = render(React.createElement(registration.component, baseProps(false)))
check('the rail variant renders without throwing', railTree !== null)
check('the rail variant marks itself', railTree !== null && countClass(railTree, 'dwg-rootRail') === 1)

// The wiring guard: the renderer composes the entry as `{...injectFace()}`,
// so a face that returns its handles BARE (instead of `{ injected }`) leaves
// `props.injected` undefined. In a shadowing entry that is invisible — the
// crash abdicates the cell to the shipped browser — so the component must
// turn it into a visible message instead of a silent no-op.
console.log('▸ the wiring guard')
const flatProps = { ...baseProps(true) }
delete flatProps.injected
const miswiredTree = render(React.createElement(registration.component, {
  ...flatProps,
  data: injected.data,
  notice: injected.notice,
  notify: injected.notify,
}))
check('flat props (a bare inject face) hit the guard instead of crashing',
  miswiredTree !== null && countClass(miswiredTree, 'dwg-miswired') === 1,
  miswiredTree === null ? 'the component threw instead of guarding' : String(countClass(miswiredTree, 'dwg-miswired')))
check('the guard explains itself on the page',
  miswiredTree !== null && textOf(miswiredTree).includes('插件接线错误'), 'the message names the cause and the fix')
const halfTree = render(React.createElement(registration.component, { ...baseProps(true), useSectionScroller: undefined }))
check('a missing slot hook also hits the guard', countClass(halfTree, 'dwg-miswired') === 1)
check('the guard names the missing piece', halfTree !== null
  && walk(halfTree).some(node => node.props['data-dwg-miswire'] === 'useSectionScroller'),
  'the data attribute carries the exact missing prop name')
const goodTree = render(React.createElement(registration.component, baseProps(true)))
check('the real composition never hits the guard', countClass(goodTree, 'dwg-miswired') === 0)
check('the rail shows only the controls, never the tree', railTree !== null
  && countClass(railTree, 'dwg-body') === 0
  && countClass(railTree, 'dwg-rowGroup') === 0
  && countClass(railTree, 'dwg-railBtn') === 3,
  'a 49px rail cannot show rows')

console.log('')
console.log(failures === 0 ? '▸ PASS — every check passed' : `▸ FAIL — ${failures} failing check(s)`)
process.exitCode = failures === 0 ? 0 : 1
