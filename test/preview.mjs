/**
 * Render the REAL plugin into standalone HTML pages, so the result can be
 * looked at instead of trusted.
 *
 * This is a documentation tool, not a test: it mounts the shipped client
 * bundle in jsdom and writes out the plugin's own CSS plus the live DOM. A
 * screenshot of the result shows the actual geometry and the actual theme
 * tokens — which the test suites cannot prove on their own.
 *
 *   node test/preview.mjs                  → docs/preview-tree.html   + preview-dialog.html
 *   node test/preview.mjs --dark           → the dark variants
 *   node test/preview.mjs --all-groups     → a fixture with no pinned band,
 *                                            the case that had two rules
 *
 * The fake parts are only the DSH context and the fixture document — the same
 * seams test/mount.mjs uses. Nothing about the plugin itself is simulated.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Resolve react/react-dom/jsdom the way the other suites do (WG_REACT_ROOT first). */
const resolvePackage = (name) => {
  const bases = [process.env.WG_REACT_ROOT, join(root, 'node_modules'), join(root, '..', 'node_modules')].filter(Boolean)
  for (const base of bases) {
    try {
      return createRequire(join(base, 'placeholder.cjs')).resolve(name)
    } catch { /* try the next base */ }
  }
  return null
}

const reactPath = resolvePackage('react')
const clientPath = resolvePackage('react-dom/client')
const domPath = resolvePackage('react-dom')
const jsdomPath = resolvePackage('jsdom')
if (reactPath === null || clientPath === null || jsdomPath === null) {
  console.log('SKIP — react / react-dom / jsdom not installed (set WG_REACT_ROOT)')
  process.exit(0)
}

const React = createRequire(import.meta.url)(reactPath)
const ReactDOMClient = createRequire(import.meta.url)(clientPath)
const ReactDOM = domPath === null ? null : createRequire(import.meta.url)(domPath)
const { JSDOM } = createRequire(import.meta.url)(jsdomPath)

const dark = process.argv.includes('--dark')
const variant = process.argv.includes('--all-groups')
const allPinned = process.argv.includes('--all-pinned')
const suffix = `${dark ? '-dark' : ''}${variant ? '-flat' : ''}${allPinned ? '-pinned' : ''}`

/** The theme's own values, copied from dsh-client-ui-theme design-platform.css. */
const LIGHT = `
--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f6f7f8;
--dsw-alias-bg-layer-3:#eff1f3;--dsw-alias-bg-overlay:#fff;--dsw-alias-specific-sidebar-fill:#f9fafb;
--dsw-alias-border-l1:rgba(0,0,0,.04);--dsw-alias-border-l2:rgba(0,0,0,.1);
--dsw-alias-border-l3:rgba(0,0,0,.12);--dsw-alias-border-l4:rgba(0,0,0,.16);
--dsw-alias-label-primary:rgb(15,17,21);--dsw-alias-label-secondary:rgba(15,17,21,.72);
--dsw-alias-label-tertiary:rgba(15,17,21,.52);--dsw-alias-label-dimmed:rgba(15,17,21,.36);
--dsw-alias-label-primary-foreground:#fff;--dsw-alias-label-on-color:#fff;
--dsw-alias-state-business-primary:rgb(65,118,230);--dsw-alias-state-error-primary:rgb(236,19,19);
--dsw-alias-interactive-bg-hover:rgba(0,0,0,.06);
--dsw-alias-button-primary-fill:rgb(15,17,21);--dsw-alias-button-primary-hover:rgb(67,69,74);
--dsw-focus-ring-width:2px;`
const DARK = `
--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#1e1e21;--dsw-alias-bg-layer-2:#26262a;
--dsw-alias-bg-layer-3:#2e2e33;--dsw-alias-bg-overlay:#26262a;--dsw-alias-specific-sidebar-fill:#1e1e21;
--dsw-alias-border-l1:rgba(255,255,255,.06);--dsw-alias-border-l2:rgba(255,255,255,.12);
--dsw-alias-border-l3:rgba(255,255,255,.16);--dsw-alias-border-l4:rgba(255,255,255,.2);
--dsw-alias-label-primary:rgb(249,250,251);--dsw-alias-label-secondary:rgba(249,250,251,.72);
--dsw-alias-label-tertiary:rgba(249,250,251,.52);--dsw-alias-label-dimmed:rgba(249,250,251,.36);
--dsw-alias-label-primary-foreground:rgb(15,17,21);--dsw-alias-label-on-color:#fff;
--dsw-alias-state-business-primary:rgb(122,170,255);--dsw-alias-state-error-primary:rgb(242,90,90);
--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);
--dsw-alias-button-primary-fill:rgb(249,250,251);--dsw-alias-button-primary-hover:rgb(235,238,242);
--dsw-focus-ring-width:2px;`

const now = Date.now()
const WORKSPACES = [
  { workspaceId: 'w1', path: 'C:/work/notes', title: 'notes', sessionIds: ['s1'], createdAt: 'a', updatedAt: 'b' },
  { workspaceId: 'w2', path: 'C:/work/acme-site', title: 'acme-site', sessionIds: ['s2', 's3'], createdAt: 'a', updatedAt: 'b' },
  { workspaceId: 'w3', path: 'C:/work/rust', title: 'rust-notes', sessionIds: ['s4'], createdAt: 'a', updatedAt: 'b' },
  { workspaceId: 'w4', path: 'C:/work/game', title: 'game-prototype', sessionIds: ['s5'], createdAt: 'a', updatedAt: 'b' },
]
const SESSIONS = {
  ids: ['s1', 's2', 's3', 's4', 's5'],
  byId: {
    s1: { id: 's1', title: '整理笔记', updatedAt: now - 86_400_000, running: false, blank: false, retainedBy: {} },
    s2: { id: 's2', title: '登录页重构', updatedAt: now - 60_000, running: true, blank: false, retainedBy: {} },
    s3: { id: 's3', title: '打包失败排查', updatedAt: now - 3_600_000, running: false, blank: false, retainedBy: {} },
    s4: { id: 's4', title: 'rust 生命周期', updatedAt: now - 7_200_000, running: false, blank: false, retainedBy: {} },
    s5: { id: 's5', title: '碰撞检测草稿', updatedAt: now - 120_000, running: false, blank: false, retainedBy: {} },
  },
}

const baseDocument = {
  version: 1,
  groups: [
    { id: 'g1', name: '客户端项目', color: 'blue', icon: 'code', pinned: true, collapsed: false, order: 0, createdAt: 1 },
    { id: 'g2', name: '学习', color: 'green', icon: 'book', pinned: false, collapsed: false, order: 0, createdAt: 2 },
    { id: 'g3', name: '游戏原型', color: 'orange', icon: 'rocket', pinned: false, collapsed: true, order: 1, createdAt: 3 },
  ],
  archivedGroups: [],
  assign: { w2: 'g1', w3: 'g2', w4: 'g3' },
  orders: { g1: ['w2'], g2: ['w3'], g3: ['w4'], __ungrouped__: ['w1'] },
  workspaceState: { w2: { expanded: true, showAll: false }, w3: { expanded: true, showAll: false } },
  ui: { view: 'grouped' },
  settings: { previewSessions: 2, searchLimit: 80 },
  persisted: true,
  error: null,
  file: 'C:/preview/state.json',
}

/** `--all-groups` unpins everything, `--all-pinned` pins everything. */
const DOCUMENT = variant
  ? {
    ...baseDocument,
    groups: baseDocument.groups.map(group => ({ ...group, pinned: false })),
  }
  : allPinned
    ? {
      ...baseDocument,
      groups: baseDocument.groups.map(group => ({ ...group, pinned: true })),
    }
    : baseDocument

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/', pretendToBeVisual: true,
})
const jsdomWindow = dom.window
globalThis.window = jsdomWindow
globalThis.document = jsdomWindow.document
globalThis.HTMLElement = jsdomWindow.HTMLElement
globalThis.Node = jsdomWindow.Node
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => structuredClone(DOCUMENT) })

// ── load the bundle the way the browser does ───────────────────────────
let loaded = null
jsdomWindow.__ModuleLoader__ = { load: registration => { loaded = registration } }
globalThis.__ModuleLoader__ = jsdomWindow.__ModuleLoader__
new Function(readFileSync(join(root, 'client', 'client.js'), 'utf8')).call(globalThis)
const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error(`preview: unexpected require ${name}`)
})

// ── drive the region like the slot renderer would ──────────────────────
const registrations = []
let localeTable = null
const services = {
  workspaces: {
    create: async input => ({ workspaceId: 'w-new', path: input.path }), rename: async () => {},
    delete: async () => {}, insertSessionBefore: async () => {},
  },
  uiWorkspace: {
    pickDirectory: async () => 'C:/picked', startSession() {}, openSession() {},
    archiveSession() {}, unarchiveSession() {}, connectWorkspace() {}, openWorkspace() {},
  },
  contextMenus: { open() {} },
}
const fakeCtx = {
  logger: { warn() {}, error() {} },
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject(servicesList, callback) { callback({ ...fakeCtx, shortcuts: { register: () => () => {} } }) },
  get(name) { return services[name] },
  locale: {
    register(_ns, table) { localeTable = table },
    bind() {
      return (key, params) => {
        const template = (localeTable?.zh ?? {})[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      }
    },
  },
  slots: {
    currentKey: null,
    inject(key, callback) { callback(); return () => {} },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
}
plugin.apply(fakeCtx)

const applied = registrations[0]
if (applied === undefined) {
  console.log('FAIL — the bundle did not register a slot entry')
  process.exit(1)
}

const selectHook = value => selector => selector(value)
const props = {
  wide: true,
  expandSidebar: () => {},
  useWorkspaces: selectHook({ items: WORKSPACES, phase: 'ready', state: 'idle', error: null, archivedSessionIds: [], pinnedSessionIds: [] }),
  useSessions: selectHook(SESSIONS),
  useSessionStatus: selectHook(new Map()),
  useSectionScroller: () => ({ bindScrollerRef: () => {} }),
  ...applied.options.inject(),
  t: fakeCtx.locale.bind(),
}

const container = document.getElementById('root')
const rootReact = ReactDOMClient.createRoot(container)
await React.act(async () => { rootReact.render(React.createElement(applied.component, props)) })
await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })

/** The plugin injects its stylesheet into <head> itself; harvest exactly that. */
const pluginCss = [...document.head.querySelectorAll('style[data-plugin="dsh-workspace-groups"]')]
  .map(node => node.textContent)
  .join('\n')

const page = (title, width, bodyHtml, extraCss = '', extraBodyCss = '') => `<!doctype html>
<html lang="zh"${dark ? ' data-ds-dark-theme=""' : ''}>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
/* The DSH theme tokens this plugin reads, at their real values. */
:root{${dark ? DARK : LIGHT}}
html,body{margin:0;height:100%}
body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:"Segoe UI",Inter,system-ui,-apple-system,sans-serif;
  display:flex;align-items:center;justify-content:center}
</style>
<style data-from-plugin="1">
/* The plugin's own stylesheet, exactly as it injected it into <head>. */
${pluginCss}
</style>
<style>
/* Stand-ins for the two surfaces the region normally sits on, so the seam
   between the header, the tree and the page edge is visible. */
.surface{width:${width}px;height:560px;background:var(--dsw-alias-specific-sidebar-fill);
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
${extraCss}
</style>
${extraBodyCss}
</head>
<body>
<div class="surface">${bodyHtml}</div>
</body>
</html>
`

const treeFile = join(root, 'docs', `preview-tree${suffix}.html`)
writeFileSync(treeFile, page('dsh-workspace-groups · 侧栏', 280, container.innerHTML), 'utf8')
console.log(`wrote ${treeFile} — ${dark ? 'dark' : 'light'}${variant ? ', flat (no pin band)' : ''}`)

// Then open a group's menu → its one edit entry, and dump the dialog page.
const menuButton = container.querySelector('[data-dwg-group="g1"] .dwg-iconBtnMenu')
if (menuButton !== null) {
  await React.act(async () => {
    menuButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  })
  const entry = [...document.querySelectorAll('.dwg-menu [role="menuitem"]')]
    .find(item => item.textContent?.trim() === '编辑分组…')
  if (entry !== undefined) {
    await React.act(async () => {
      entry.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    })
  }
}

const dialogFile = join(root, 'docs', `preview-dialog${suffix}.html`)
const dialogPage = page('dsh-workspace-groups · 编辑分组', 280, document.body.innerHTML)
writeFileSync(dialogFile, dialogPage, 'utf8')
const open = dialogPage.includes('dwg-dialog')
console.log(`wrote ${dialogFile} — dialog ${open ? 'open' : 'MISSING'}`)

/**
 * A button-state sheet.
 *
 * A static page cannot hover, so the hover rule is FORCED by copying the
 * shipped declarations out of the plugin's own stylesheet and re-emitting them
 * under an attribute selector. Nothing is re-typed: the declarations shown are
 * byte-for-byte the ones the plugin uses, only the selector differs. That is
 * the honest way to screenshot a hover state without faking the colours.
 */
const declarationsOf = (selector) => {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
  return pluginCss.match(pattern)?.[1] ?? null
}
const primaryHover = declarationsOf('.dwg-btnPrimary:hover:not(:disabled)')
const dangerHover = declarationsOf('.dwg-btnDanger:hover:not(:disabled)')
if (primaryHover === null || dangerHover === null) {
  console.log('FAIL — the hover declarations are not in the stylesheet any more')
  process.exit(1)
}

const buttonsFile = join(root, 'docs', `preview-buttons${suffix}.html`)
const buttonsPage = page(
  'dsh-workspace-groups · 按钮状态',
  440,
  `
<div class="surface" style="height:auto;padding:20px;box-sizing:border-box;display:flex;flex-direction:column;gap:14px">
  <span style="font-size:12px;color:var(--dsw-alias-label-tertiary)">默认</span>
  <div class="dwg-dialogActions" style="justify-content:flex-start">
    <button type="button" class="dwg-btn">取消</button>
    <button type="button" class="dwg-btn dwg-btnPrimary">保存</button>
    <button type="button" class="dwg-btn dwg-btnPrimary dwg-btnDanger">删除</button>
  </div>
  <span style="font-size:12px;color:var(--dsw-alias-label-tertiary)">hover（把真实 hover 声明套到 [data-hover] 上）</span>
  <div class="dwg-dialogActions" style="justify-content:flex-start">
    <button type="button" class="dwg-btn" data-hover>取消</button>
    <button type="button" class="dwg-btn dwg-btnPrimary" data-hover>保存</button>
    <button type="button" class="dwg-btn dwg-btnPrimary dwg-btnDanger" data-hover>删除</button>
  </div>
</div>
`,
  `body{display:block;padding:24px;height:auto}
.surface{height:auto;width:440px;border-radius:12px}`,
  `<style>
/* Copied verbatim from the plugin stylesheet; only the selector is rewritten. */
.dwg-btnPrimary[data-hover]{${primaryHover}}
.dwg-btnDanger[data-hover]{${dangerHover}}
</style>`,
)
writeFileSync(buttonsFile, buttonsPage, 'utf8')
console.log(`wrote ${buttonsFile} — forced hover from the shipped declarations`)
process.exit(open ? 0 : 1)
