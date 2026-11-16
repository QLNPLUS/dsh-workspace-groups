/**
 * dsh-workspace-groups — browser half.
 *
 * Renders the sidebar's browsing region (`sidebar.workspaces`) as a
 * group → project → conversation tree. It registers INTO that `single` cell
 * with a lower `priority` than the shipped entry (which registers at the
 * default 0), so this entry is the one the renderer picks — the documented way
 * to deliberately replace a shipped single cell rather than shadow it by
 * accident.
 *
 * Division of labour:
 *   - DSH keeps ownership of what EXISTS: Workspaces, Sessions, titles, and the
 *     registry-global archive / pin sets. This file reads them from the slot's
 *     standard props (`useWorkspaces`, `useSessions`, `useSessionStatus`) and
 *     drives them through the same client services every other domain uses
 *     (`uiWorkspace`, `workspaces`, `contextMenus`).
 *   - This plugin owns only the TREE: which project belongs to which group,
 *     each group's name / colour / icon / pin, per-section order, fold state,
 *     and the view mode. That document lives on the Host half and is read and
 *     written over its two JSON routes. Referencing workspace ids only — never
 *     a second source of truth for what exists — is what makes an uninstalled
 *     plugin leave DSH exactly as it was.
 *
 * Seats the replaced entry had declared, and which therefore stop rendering:
 * `sidebar.workspaces.directoryFlow`, `sidebar.workspaces.session.row.action`,
 * `sidebar.session.row.leading` / `.trailing` / `.hover`, and the legacy
 * `sidebar.workspaces.session.menu.item`. Every equivalent this region needs is
 * re-implemented here (native directory picking through
 * `uiWorkspace.pickDirectory()`, in-row hover buttons, its own search field,
 * its own dialogs). The built-in Session menus (`target: 'session'`), the two
 * Session overlay dialogs, and the `target: 'workspace'` menu rows belong to
 * ui-workspace's own activation rather than to that entry, so they keep
 * working: a conversation row's context menu here IS the shipped DSH menu,
 * opened through the public `contextMenus.open()`.
 *
 * The Workspace rename/delete DIALOGS, by contrast, are rendered by the browser
 * component itself; replacing the browser is why project rename and project
 * deletion are implemented in this file with this plugin's own dialog.
 *
 * Styling: one injected stylesheet. Every chrome colour resolves through a
 * shipped `--dsw-alias-*` token, so switching themes changes the palette rather
 * than breaking the surface. Only a group's glyph and its 2px leading bar carry
 * an accent, from the ten-entry palette below; the dark hex pair is applied under
 * `body[data-ds-dark-theme]`, the attribute the theme presenter sets.
 *
 * @module dsh-workspace-groups/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-groups',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React

    let ReactDOM
    try {
      ReactDOM = require('react-dom')
    } catch (error) {
      ReactDOM = undefined
    }

    // ═══════════════════════════════════════════════════════════════════
    // Wire contract shared with plugin/index.mjs
    // ═══════════════════════════════════════════════════════════════════

    /** Read the whole grouping document. */
    const STATE_PATH = '/api/workspace-groups/state'
    /** Apply one mutation; the answer is the new complete document. */
    const MUTATE_PATH = '/api/workspace-groups/mutate'
    /** Locale namespace this bundle owns. */
    const NS = 'workspaceGroups'
    /** Assignment/order key for "no group"; mirrors the Host half's literal. */
    const UNGROUPED = '__ungrouped__'
    /** Pause between the latest keystroke and a re-derived search. */
    const SEARCH_DEBOUNCE_MS = 170
    /** Wire bound on a group or project name. */
    const NAME_MAX = 40
    /** Registry target family for conversation rows (the shipped one). */
    const SESSION_TARGET = 'session'

    /** Preset accents, in palette order. */
    const COLORS = ['blue', 'indigo', 'violet', 'rose', 'red', 'orange', 'amber', 'green', 'teal', 'slate']
    /**
     * Accent hex pairs, `[light, dark]`. Every pair clears 4.0:1 against the
     * corresponding sidebar surface, and the dark step is the light hue raised
     * one notch so it reads as a dot rather than a hole.
     */
    const PALETTE = {
      blue: ['#4176E6', '#7AAAFF'],
      indigo: ['#4B4FD8', '#9C9CFF'],
      violet: ['#7C3AED', '#A78BFA'],
      rose: ['#D6336C', '#FAA2C1'],
      red: ['#D92D20', '#F97066'],
      orange: ['#C2410C', '#FFA94D'],
      amber: ['#B45309', '#F7AD31'],
      green: ['#1F7A33', '#4ED17E'],
      teal: ['#0E7490', '#2DC8EB'],
      slate: ['#61666B', '#CFD3D6'],
    }
    /** Group glyphs as 24px stroke paths (Tabler Icons, MIT — see NOTICE). */
    const ICON_PATHS = {
      folder: ['M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2'],
      star: ['M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873l-6.158 -3.245'],
      heart: ['M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572'],
      flag: ['M5 5a5 5 0 0 1 7 0a5 5 0 0 0 7 0v9a5 5 0 0 1 -7 0a5 5 0 0 0 -7 0v-9', 'M5 21v-7'],
      bookmark: ['M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4'],
      bolt: ['M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11'],
      flame: ['M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.294 -2.333 5.588c0 3.704 3.134 6.706 7 6.706c3.866 0 7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235'],
      rocket: ['M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3', 'M7 14a6 6 0 0 0 -3 6a6 6 0 0 0 6 -3', 'M14 9a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'],
      bug: ['M9 9v-1a3 3 0 0 1 6 0v1', 'M8 9h8a6 6 0 0 1 1 3v3a5 5 0 0 1 -10 0v-3a6 6 0 0 1 1 -3', 'M3 13l4 0', 'M17 13l4 0', 'M12 20l0 -6', 'M4 19l3.35 -2', 'M20 19l-3.35 -2', 'M4 7l3.75 2.4', 'M20 7l-3.75 2.4'],
      code: ['M7 8l-4 4l4 4', 'M17 8l4 4l-4 4', 'M14 4l-4 16'],
      terminal: ['M5 7l5 5l-5 5', 'M12 19l7 0'],
      book: ['M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0', 'M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0', 'M3 6l0 13', 'M12 6l0 13', 'M21 6l0 13'],
      bulb: ['M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7', 'M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3', 'M9.7 17l4.6 0'],
      briefcase: ['M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9', 'M8 7v-2a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2', 'M12 12l0 .01', 'M3 13a20 20 0 0 0 18 0'],
      home: ['M5 12l-2 0l9 -9l9 9l-2 0', 'M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7', 'M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6'],
      flask: ['M9 3l6 0', 'M10 9l4 0', 'M10 3v6l-4 11a.7 .7 0 0 0 .5 1h11a.7 .7 0 0 0 .5 -1l-4 -11v-6'],
      palette: ['M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25', 'M7.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M11.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M15.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'],
      music: ['M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0', 'M13 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0', 'M9 17v-13h10v13', 'M9 8h10'],
      world: ['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M3.6 9h16.8', 'M3.6 15h16.8', 'M11.5 3a17 17 0 0 0 0 18', 'M12.5 3a17 17 0 0 1 0 18'],
      lock: ['M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6', 'M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0', 'M8 11v-4a4 4 0 1 1 8 0v4'],
      // Not offered in the picker: the "Ungrouped" bucket's neutral marker.
      dot: [],
    }
    /** What the picker offers; `dot` is a renderer-only glyph, not a choice. */
    const ICONS = Object.keys(ICON_PATHS).filter(icon => icon !== 'dot')

    // ═══════════════════════════════════════════════════════════════════
    // Dictionary — the locale service requires both locales at registration
    // ═══════════════════════════════════════════════════════════════════

    const ZH = {
      title: '工作区',
      'act.newProject': '新建项目',
      'act.newGroup': '新建分组',
      'act.newSession': '新建对话',
      'act.collapseAll': '全部折叠',
      'act.more': '更多操作',
      'act.grouped': '分组视图',
      'act.recent': '最近使用',
      'act.unarchive': '恢复',
      search: '搜索',
      'search.placeholder': '搜索组、项目或对话…',
      'search.clear': '清空搜索',
      'search.close': '收起搜索',
      'search.none': '没有匹配的组、项目或对话',
      'search.more': '仅显示前 {n} 条，请缩小范围',
      'search.path': '所属：{path}',
      'search.results': '搜索结果',
      'empty.group': '拖项目到这里',
      'empty.ungrouped': '把项目拖到这里即可移出分组',
      'tree.empty': '还没有项目和分组，用右上角的按钮新建。',
      'badge.pending': '{n} 待处理',
      'badge.running': '{n} 运行中',
      'badge.unread': '{n} 新完成',
      'section.ungrouped': '未分组',
      'section.archived': '已归档分组',
      'row.showAll': '查看全部 {n} 个',
      'row.showLess': '收起',
      'row.empty': '还没有对话',
      'row.untitled': '未命名对话',
      'row.blank': '新对话',
      'menu.editGroup': '编辑分组…',
      'menu.renameProject': '重命名项目…',
      'menu.pin': '固定到顶部',
      'menu.unpin': '取消固定',
      'menu.collapse': '收起分组',
      'menu.expand': '展开分组',
      'menu.archive': '归档分组',
      'menu.deleteGroup': '删除分组…',
      'menu.newProject': '在此组新建项目…',
      'menu.newSession': '新建对话',
      'menu.moveTo': '移动到组',
      'menu.moveOut': '移出分组',
      'menu.deleteProject': '删除项目…',
      'dlg.ok': '保存',
      'dlg.save': '保存',
      'dlg.cancel': '取消',
      'dlg.delete': '删除',
      'dlg.name': '名称',
      'dlg.icon': '图标',
      'dlg.color': '颜色',
      'dlg.newGroupTitle': '新建分组',
      'dlg.newGroupHint': '分组只影响左侧栏的归类，不移动、不复制任何目录。',
      'dlg.namePlaceholder': '例如：客户端项目',
      'dlg.editGroupTitle': '编辑分组',
      'dlg.renameProjectTitle': '重命名项目',
      'dlg.deleteGroupTitle': '删除分组「{name}」',
      'dlg.deleteDissolve': '解散组（项目回到未分组）',
      'dlg.deleteDissolveHint': '默认：只删分组，项目回到「未分组」。',
      'dlg.deleteWithProjects': '连同项目一起注销',
      'dlg.deleteWithProjectsHint': '组内项目会从 DSH 注销；对话记录和磁盘文件保留。',
      'dlg.deleteProjectTitle': '删除项目「{name}」',
      'dlg.deleteProjectHint': '只注销这个工作区注册；对话历史和磁盘目录都保留。',
      'dlg.pickFailed': '目录选择失败：{message}',
      'dlg.createFailed': '创建项目失败：{message}',
      'dlg.renameFailed': '重命名失败：{message}',
      'dlg.deleteFailed': '删除失败：{message}',
      'error.load': '分组数据读取失败：{message}',
      'error.retry': '重试',
      'error.save': '保存失败：{message}',
      'error.miswired': '插件接线错误：缺少 {missing}。这通常意味着 inject 面被改成了摊平形状——它必须只发布一个 prop：inject: () => ({ injected })。详见 docs/DETAIL.md 第 1 节，改好后刷新页面。',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.yesterday': '昨天',
      'time.days': '{n} 天前',
      'time.months': '{n} 个月前',
      'color.blue': '蓝色',
      'color.indigo': '靛蓝',
      'color.violet': '紫色',
      'color.rose': '玫红',
      'color.red': '红色',
      'color.orange': '橙色',
      'color.amber': '琥珀',
      'color.green': '绿色',
      'color.teal': '青色',
      'color.slate': '石板灰',
      'icon.folder': '文件夹',
      'icon.star': '星标',
      'icon.heart': '爱心',
      'icon.flag': '旗帜',
      'icon.bookmark': '书签',
      'icon.bolt': '闪电',
      'icon.flame': '火焰',
      'icon.rocket': '火箭',
      'icon.bug': '缺陷',
      'icon.code': '代码',
      'icon.terminal': '终端',
      'icon.book': '书本',
      'icon.bulb': '灯泡',
      'icon.briefcase': '公文包',
      'icon.home': '主页',
      'icon.flask': '实验',
      'icon.palette': '调色板',
      'icon.music': '音乐',
      'icon.world': '地球',
      'icon.lock': '锁定',
      'a11y.tree': '工作区分组树',
      'a11y.group': '分组 {name}，{n} 个项目',
      'a11y.project': '项目 {name}，{n} 个对话',
      'a11y.session': '对话 {name}',
      'shortcut.collapseAll': '全部折叠工作区分组',
    }

    const EN = {
      title: 'Workspaces',
      'act.newProject': 'New project',
      'act.newGroup': 'New group',
      'act.newSession': 'New conversation',
      'act.collapseAll': 'Collapse all',
      'act.more': 'More actions',
      'act.grouped': 'Grouped',
      'act.recent': 'Recent',
      'act.unarchive': 'Restore',
      search: 'Search',
      'search.placeholder': 'Search groups, projects, conversations…',
      'search.clear': 'Clear search',
      'search.close': 'Close search',
      'search.none': 'No matching group, project, or conversation',
      'search.more': 'Showing the first {n}; narrow the query',
      'search.path': 'In {path}',
      'search.results': 'Search results',
      'empty.group': 'Drag projects here',
      'empty.ungrouped': 'Drop a project here to leave its group',
      'tree.empty': 'No projects or groups yet. Use the controls at the top right.',
      'badge.pending': '{n} waiting',
      'badge.running': '{n} running',
      'badge.unread': '{n} finished',
      'section.ungrouped': 'Ungrouped',
      'section.archived': 'Archived groups',
      'row.showAll': 'Show all {n}',
      'row.showLess': 'Show fewer',
      'row.empty': 'No conversations yet',
      'row.untitled': 'Untitled conversation',
      'row.blank': 'New conversation',
      'menu.editGroup': 'Edit group…',
      'menu.renameProject': 'Rename project…',
      'menu.pin': 'Pin to top',
      'menu.unpin': 'Unpin',
      'menu.collapse': 'Collapse group',
      'menu.expand': 'Expand group',
      'menu.archive': 'Archive group',
      'menu.deleteGroup': 'Delete group…',
      'menu.newProject': 'New project in this group…',
      'menu.newSession': 'New conversation',
      'menu.moveTo': 'Move to group',
      'menu.moveOut': 'Remove from group',
      'menu.deleteProject': 'Delete project…',
      'dlg.ok': 'Save',
      'dlg.save': 'Save',
      'dlg.cancel': 'Cancel',
      'dlg.delete': 'Delete',
      'dlg.name': 'Name',
      'dlg.icon': 'Icon',
      'dlg.color': 'Color',
      'dlg.newGroupTitle': 'New group',
      'dlg.newGroupHint': 'A group only organizes the sidebar; no directory is moved or copied.',
      'dlg.namePlaceholder': 'e.g. Client projects',
      'dlg.editGroupTitle': 'Edit group',
      'dlg.renameProjectTitle': 'Rename project',
      'dlg.deleteGroupTitle': 'Delete group "{name}"',
      'dlg.deleteDissolve': 'Dissolve the group (projects return to Ungrouped)',
      'dlg.deleteDissolveHint': 'Default: only the group goes away; its projects return to Ungrouped.',
      'dlg.deleteWithProjects': 'Unregister every project in this group',
      'dlg.deleteWithProjectsHint': 'The projects are unregistered from DSH; conversations and files on disk stay.',
      'dlg.deleteProjectTitle': 'Delete project "{name}"',
      'dlg.deleteProjectHint': 'Only the workspace registration is removed; conversations and the directory stay.',
      'dlg.pickFailed': 'Directory picking failed: {message}',
      'dlg.createFailed': 'Could not create the project: {message}',
      'dlg.renameFailed': 'Rename failed: {message}',
      'dlg.deleteFailed': 'Delete failed: {message}',
      'error.load': 'Could not read the grouping data: {message}',
      'error.retry': 'Retry',
      'error.save': 'Could not save: {message}',
      'error.miswired': 'Mis-wired props: missing {missing}. The inject face likely went flat — it must publish exactly one prop: inject: () => ({ injected }). See docs/DETAIL.md §1, then refresh the page.',
      'time.now': 'just now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.yesterday': 'yesterday',
      'time.days': '{n}d ago',
      'time.months': '{n}mo ago',
      'color.blue': 'Blue',
      'color.indigo': 'Indigo',
      'color.violet': 'Violet',
      'color.rose': 'Rose',
      'color.red': 'Red',
      'color.orange': 'Orange',
      'color.amber': 'Amber',
      'color.green': 'Green',
      'color.teal': 'Teal',
      'color.slate': 'Slate',
      'icon.folder': 'Folder',
      'icon.star': 'Star',
      'icon.heart': 'Heart',
      'icon.flag': 'Flag',
      'icon.bookmark': 'Bookmark',
      'icon.bolt': 'Bolt',
      'icon.flame': 'Flame',
      'icon.rocket': 'Rocket',
      'icon.bug': 'Bug',
      'icon.code': 'Code',
      'icon.terminal': 'Terminal',
      'icon.book': 'Book',
      'icon.bulb': 'Idea',
      'icon.briefcase': 'Briefcase',
      'icon.home': 'Home',
      'icon.flask': 'Experiment',
      'icon.palette': 'Palette',
      'icon.music': 'Music',
      'icon.world': 'Globe',
      'icon.lock': 'Lock',
      'a11y.tree': 'Workspace group tree',
      'a11y.group': 'Group {name}, {n} projects',
      'a11y.project': 'Project {name}, {n} conversations',
      'a11y.session': 'Conversation {name}',
      'shortcut.collapseAll': 'Collapse every workspace group',
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    const cx = (...values) => values.filter(Boolean).join(' ')
    const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
    const reasonText = error => (error instanceof Error ? error.message : String(error))
    const matches = (haystack, needle) => (typeof haystack === 'string' && haystack.toLowerCase().includes(needle))

    /** Last path segment; a project's label fallback when it carries no title. */
    const baseName = (path) => {
      if (typeof path !== 'string' || path.length === 0) return ''
      const parts = path.split(/[\\/]+/).filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    /** Clamp a number into a range, with a fallback for non-numbers. */
    const num = (value, fallback, min, max) => (typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback)

    /** A minimal snapshot source: `getSnapshot` + `subscribe`, what hooks bind to. */
    const createSnapshotStore = (initial) => {
      let snapshot = initial
      const listeners = new Set()
      const source = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
      const set = (next) => {
        if (next === snapshot) return
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-workspace-groups: listener failed', error)
          }
        }
      }
      return { source, set }
    }

    /** Subscribe to one of this bundle's own sources. */
    const useSnapshot = (source) => {
      const subscribe = useCallback(listener => source.subscribe(listener), [source])
      const read = useCallback(() => source.getSnapshot(), [source])
      return useSyncExternalStore(subscribe, read, read)
    }

    /** The document the tree renders before the Host answers for the first time. */
    const emptyDocument = () => ({
      version: 1,
      groups: [],
      archivedGroups: [],
      assign: {},
      orders: {},
      workspaceState: {},
      ui: { view: 'grouped' },
      settings: { previewSessions: 2, searchLimit: 80 },
      /**
       * `false` until the Host has actually answered. The region needs this to
       * tell "no groups yet" apart from "nothing read yet": an empty document
       * would otherwise paint every project as Ungrouped and then move them a
       * moment later, which reads as a glitch rather than a load.
       */
      loaded: false,
      /**
       * Set only when THIS page's request failed (`error` above is the Host's
       * own report about its state file). Two different failures: one means the
       * page could not ask, the other means the Host answered with trouble.
       */
      readError: null,
      persisted: true,
      error: null,
      file: '',
    })

    /** Coerce whatever the Host answered into the shape the tree consumes. */
    const normalizeDocument = (body) => {
      const base = emptyDocument()
      if (body === null || typeof body !== 'object') return base
      const out = { ...base, ...body }
      out.groups = Array.isArray(out.groups) ? out.groups : []
      out.archivedGroups = Array.isArray(out.archivedGroups) ? out.archivedGroups : []
      out.assign = out.assign !== null && typeof out.assign === 'object' ? out.assign : {}
      out.orders = out.orders !== null && typeof out.orders === 'object' ? out.orders : {}
      out.workspaceState = out.workspaceState !== null && typeof out.workspaceState === 'object' ? out.workspaceState : {}
      out.ui = out.ui !== null && typeof out.ui === 'object' ? out.ui : { view: 'grouped' }
      out.settings = out.settings !== null && typeof out.settings === 'object'
        ? {
          previewSessions: num(out.settings.previewSessions, 2, 1, 6),
          searchLimit: num(out.settings.searchLimit, 80, 20, 400),
        }
        : { previewSessions: 2, searchLimit: 80 }
      // Anything that reached this function came out of a Host answer, so the
      // document is authoritative from here on and the page-level read failure
      // (if there was one) is over.
      out.loaded = true
      out.readError = null
      return out
    }

    /**
     * The grouping document handle for the page.
     *
     * Mutations are not optimistic: the Host answers with the complete
     * normalized document, and publishing that answer is both the render update
     * and the failure report. Writes run one at a time, so a drag that lands
     * while a rename is in flight cannot resolve out of order.
     */
    const createGroupsStore = (log) => {
      const store = createSnapshotStore(emptyDocument())
      let reading = null
      let chain = Promise.resolve()
      let failure = null

      /**
       * Read the grouping document.
       *
       * A failure marks the document with `readError` instead of leaving it
       * blank: the tree must not sit on a loading placeholder forever when the
       * route is unreachable, and it must not silently pretend the Host has no
       * groups. It keeps whatever it already had (usually nothing) and shows a
       * retry the user can press.
       */
      const read = async () => {
        try {
          const response = await fetch(STATE_PATH, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          store.set(normalizeDocument(await response.json()))
          failure = null
        } catch (error) {
          failure = reasonText(error)
          log.warn('state read failed', error)
          const current = store.source.getSnapshot()
          store.set({ ...current, readError: failure })
        }
      }

      const mutate = (action, payload) => {
        const send = async () => {
          const response = await fetch(MUTATE_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ action, payload: payload ?? {} }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          store.set(normalizeDocument(await response.json()))
          return store.source.getSnapshot()
        }
        const result = chain.then(send, send)
        chain = result.then(() => {}, () => {})
        return result
      }

      return {
        source: store.source,
        start() {
          if (reading !== null) return reading
          reading = read().then(() => { reading = null }, () => { reading = null })
          return reading
        },
        get failure() {
          return failure
        },
        mutate,
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Tree derivation
    // ═══════════════════════════════════════════════════════════════════

    /** Status dot kind, in the shipped precedence: pending → running → done. */
    const primaryStatus = (node) => {
      if (node.pendingInteraction !== undefined) return 'warning'
      if (node.running) return 'ongoing'
      if (node.completed) return 'done'
      return 'idle'
    }

    /**
     * Reconcile a stored id order against live members: stored ids that still
     * exist keep their relative slots and everything else appends in the caller's
     * order. A project dragged into a group therefore keeps its place while
     * unrelated projects come and go, and an id the Host deleted simply drops.
     */
    const reconcileOrder = (members, stored) => {
      const live = new Set(members)
      const out = []
      const seen = new Set()
      for (const id of Array.isArray(stored) ? stored : []) {
        if (!live.has(id) || seen.has(id)) continue
        out.push(id)
        seen.add(id)
      }
      for (const id of members) {
        if (seen.has(id)) continue
        out.push(id)
        seen.add(id)
      }
      return out
    }

    /** One conversation row's presentation facts. */
    const sessionNode = (summary, status, pinnedSet, archivedSet) => {
      const kind = status?.pendingInteraction?.kind
      const archived = archivedSet.has(summary.id)
      return {
        kind: 'session',
        key: `s:${summary.id}`,
        id: summary.id,
        title: text(summary.title) ?? '',
        blank: summary.blank === true,
        running: (status?.running ?? summary.running) === true,
        completed: status?.completionUnread === true,
        pendingInteraction: kind === 'approval' || kind === 'plan-review' || kind === 'question' ? kind : undefined,
        updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
        archived,
        pinned: !archived && pinnedSet.has(summary.id),
      }
    }

    /** Reduce conversation rows into the counters a header badge shows. */
    const countersOf = sessions => ({
      unread: sessions.filter(node => node.completed).length,
      running: sessions.filter(node => node.running).length,
      pending: sessions.filter(node => node.pendingInteraction !== undefined).length,
      updatedAt: sessions.reduce((max, node) => Math.max(max, node.updatedAt), 0),
    })

    /**
     * Build the whole tree from the DSH snapshots plus the grouping document.
     * Pure, so the tree, the search index, the keyboard walk and the recent view
     * share one definition of what is on screen.
     *
     * @param workspaces - `useWorkspaces(s => s.items)`, Host registry order.
     * @param sessions - `useSessions(s => s)` (ids + byId).
     * @param statuses - `useSessionStatus(s => s)`.
     * @param pins - registry-global pinned Session ids.
     * @param archives - registry-global archived Session ids.
     * @param document - this plugin's grouping document.
     */
    const deriveModel = (workspaces, sessions, statuses, pins, archives, document) => {
      const byId = sessions?.byId ?? {}
      const pinnedSet = new Set(pins ?? [])
      const archivedSet = new Set(archives ?? [])
      const assign = document.assign ?? {}
      const orders = document.orders ?? {}
      const workspaceState = document.workspaceState ?? {}
      const previewSessions = num(document.settings?.previewSessions, 2, 1, 6)

      /**
       * Visible conversations of one project, in its section's stored order.
       *
       * Two filters, both copied from the shipped browser so a replaced region
       * shows the same set of rows it would have shown:
       *   - subagent Sessions are not browsing rows;
       *   - of the provisional blank Sessions, only the one retained by the
       *     main view is shown (the shipped `currentBlank` rule), so a
       *     "New conversation" placeholder cannot accumulate per project.
       */
      const sessionsOf = (workspace, groupKey) => {
        const members = (workspace.sessionIds ?? []).filter((id) => {
          const summary = byId[id]
          if (summary === undefined || summary.origin === 'subagent') return false
          return summary.blank !== true || (summary.retainedBy?.mainView ?? 0) > 0
        })
        return reconcileOrder(members, orders[groupKey])
          .map(id => sessionNode(byId[id], statuses?.get?.(id), pinnedSet, archivedSet))
      }

      const projectOf = (workspace) => {
        const groupKey = assign[workspace.workspaceId] ?? UNGROUPED
        const state = workspaceState[workspace.workspaceId] ?? {}
        const sessions = sessionsOf(workspace, groupKey)
        const expanded = state.expanded === true
        const showAll = state.showAll === true
        const visible = expanded ? (showAll ? sessions : sessions.slice(0, previewSessions)) : []
        return {
          kind: 'project',
          key: `w:${workspace.workspaceId}`,
          workspaceId: workspace.workspaceId,
          title: text(workspace.title) ?? baseName(workspace.path),
          path: workspace.path,
          groupKey,
          sessions,
          visible,
          hidden: Math.max(0, sessions.length - visible.length),
          expanded,
          showAll,
          count: sessions.length,
          ...countersOf(sessions),
          archived: false,
        }
      }

      const orderProjects = (sectionKey, items) => {
        const at = new Map(items.map(item => [item.workspaceId, item]))
        const out = []
        for (const id of reconcileOrder(items.map(item => item.workspaceId), orders[sectionKey])) {
          const item = at.get(id)
          if (item !== undefined) out.push(item)
        }
        return out
      }

      const projects = (workspaces ?? []).map(projectOf)

      const buckets = new Map()
      for (const group of document.groups ?? []) buckets.set(group.id, [])
      const loose = []
      for (const project of projects) {
        const groupId = assign[project.workspaceId]
        if (typeof groupId === 'string' && buckets.has(groupId)) buckets.get(groupId).push(project)
        else loose.push(project)
      }

      const sectionOf = (group) => {
        const items = orderProjects(group.id, buckets.get(group.id) ?? [])
        return {
          kind: 'group',
          key: `g:${group.id}`,
          id: group.id,
          name: text(group.name) ?? group.id,
          color: group.color,
          icon: group.icon,
          pinned: group.pinned === true,
          collapsed: group.collapsed === true,
          order: group.order,
          createdAt: group.createdAt,
          allProjects: items,
          projects: group.collapsed === true ? [] : items,
          count: items.length,
          ...countersOf(items.flatMap(item => item.sessions)),
          archived: false,
        }
      }

      const live = (document.groups ?? []).slice().sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      const sections = live.map(sectionOf)

      return {
        pinned: sections.filter(section => section.pinned),
        groups: sections.filter(section => !section.pinned),
        ungrouped: {
          kind: 'ungrouped',
          key: `u:${UNGROUPED}`,
          id: UNGROUPED,
          projects: orderProjects(UNGROUPED, loose),
          count: loose.length,
          ...countersOf(loose.flatMap(item => item.sessions)),
          archived: false,
        },
        archivedGroups: (document.archivedGroups ?? []).map(group => ({
          kind: 'group',
          key: `a:${group.id}`,
          id: group.id,
          name: text(group.name) ?? group.id,
          color: group.color,
          icon: group.icon,
          pinned: false,
          collapsed: true,
          archived: true,
          allProjects: [],
          projects: [],
          count: 0,
          unread: 0,
          running: 0,
          pending: 0,
          updatedAt: 0,
        })),
        view: document.ui?.view === 'recent' ? 'recent' : 'grouped',
        previewSessions,
      }
    }

    /** Flat "recent" rows: every conversation, newest first, with its project. */
    const deriveRecent = (workspaces, sessions, statuses, pins, archives) => {
      const byId = sessions?.byId ?? {}
      const pinnedSet = new Set(pins ?? [])
      const archivedSet = new Set(archives ?? [])
      const owner = new Map()
      for (const workspace of workspaces ?? []) {
        for (const id of workspace.sessionIds ?? []) owner.set(id, workspace)
      }
      const rows = []
      const push = (id) => {
        const summary = byId[id]
        if (summary === undefined || summary.origin === 'subagent') return
        // Same blank-Session rule as the tree: only the main view's placeholder.
        if (summary.blank === true && (summary.retainedBy?.mainView ?? 0) === 0) return
        const workspace = owner.get(id)
        rows.push({
          ...sessionNode(summary, statuses?.get?.(id), pinnedSet, archivedSet),
          key: `r:${id}`,
          workspaceId: workspace === undefined ? undefined : workspace.workspaceId,
          projectTitle: workspace === undefined ? '' : (text(workspace.title) ?? baseName(workspace.path)),
        })
      }
      for (const workspace of workspaces ?? []) for (const id of workspace.sessionIds ?? []) push(id)
      for (const id of sessions?.ids ?? []) if (!owner.has(id)) push(id)
      return rows.sort((left, right) => right.updatedAt - left.updatedAt)
    }

    /**
     * Search group names, project names and conversation titles in one pass,
     * keeping the owning group and project on every hit so a result always says
     * where it lives.
     */
    const deriveSearch = (model, recent, query, limit) => {
      const needle = query.trim().toLowerCase()
      const hits = []
      let seen = 0
      const push = (hit) => {
        seen += 1
        if (hits.length < limit) hits.push(hit)
      }
      const visit = (group, items) => {
        if (group !== null && matches(group.name, needle)) {
          push({ kind: 'group', key: group.key, title: group.name, group, project: null, session: null })
        }
        for (const item of items) {
          if (matches(item.title, needle)) {
            push({ kind: 'project', key: item.key, title: item.title, group, project: item, session: null })
          }
          for (const node of item.sessions) {
            if (!matches(node.title, needle)) continue
            push({ kind: 'session', key: node.key, title: node.title, group, project: item, session: node })
          }
        }
      }
      for (const group of model.pinned) visit(group, group.allProjects)
      for (const group of model.groups) visit(group, group.allProjects)
      visit(null, model.ungrouped.projects)
      for (const node of recent) {
        if (!matches(node.title, needle)) continue
        push({
          kind: 'session',
          key: `search:${node.key}`,
          title: node.title,
          group: null,
          project: node.workspaceId === undefined
            ? null
            : { key: `w:${node.workspaceId}`, workspaceId: node.workspaceId, title: node.projectTitle, sessions: [] },
          session: node,
        })
      }
      return { hits, hasMore: seen > hits.length, total: seen }
    }

    /** "12 分钟前" style relative time. */
    const relativeTime = (ms, t) => {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const delta = Date.now() - ms
      if (delta < 60_000) return t('time.now')
      if (delta < 3_600_000) return t('time.minutes', { n: Math.floor(delta / 60_000) })
      if (delta < 86_400_000) return t('time.hours', { n: Math.floor(delta / 3_600_000) })
      if (delta < 2 * 86_400_000) return t('time.yesterday')
      if (delta < 30 * 86_400_000) return t('time.days', { n: Math.floor(delta / 86_400_000) })
      return t('time.months', { n: Math.floor(delta / (30 * 86_400_000)) })
    }

    /** The badge text for a node with live status; '' when quiet. */
    const badgeText = (node, t) => {
      if (node.pending > 0) return t('badge.pending', { n: node.pending })
      if (node.running > 0) return t('badge.running', { n: node.running })
      if (node.unread > 0) return t('badge.unread', { n: node.unread })
      return ''
    }

    // ═══════════════════════════════════════════════════════════════════
    // Atoms
    // ═══════════════════════════════════════════════════════════════════

    /**
     * One icon, drawn from a Tabler outline path list.
     *
     * Tabler's grid is 24×24 with a 2px stroke. Every icon in this file uses
     * that grid rather than a hand-drawn 16 one, so the whole region speaks one
     * visual language: mixing a 16-grid icon drawn at 1.7 with a 24-grid icon
     * scaled into a 16 viewBox makes the second one look half again as heavy
     * (a 2px stroke on a 24 grid rendered into 16 keeps 2/24 of the width, so
     * the ink lands at 2.67px nominal — visibly blunt).
     */
    const Glyph = ({ paths, size = 14, className }) => h(
      'svg',
      {
        className: cx('dwg-glyphIc', className),
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': 'true',
        focusable: 'false',
      },
      paths.map((d, index) => h('path', {
        key: index, d, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      })),
    )

    /**
     * One group glyph. `dot` has no paths on purpose: it is the neutral marker
     * the Ungrouped bucket uses, drawn as a filled circle by the stylesheet.
     */
    const GroupGlyph = ({ icon, className }) => {
      const paths = ICON_PATHS[icon] ?? ICON_PATHS.folder
      if (paths.length === 0) return h('span', { className: cx('dwg-glyph', 'dwg-glyphDot', className), 'aria-hidden': 'true' })
      return h(Glyph, { paths, size: 14, className: cx('dwg-glyph', className) })
    }

    const Chevron = ({ open }) => h(Glyph, {
      paths: CHEVRON_RIGHT,
      size: 12,
      className: cx('dwg-chevron', open && 'dwg-chevronOpen'),
    })

    const StateDot = ({ state }) => h('span', { className: cx('dwg-dot', `dwg-dot-${state}`), 'aria-hidden': 'true' })

    /** Small square icon button used by the header and rows. */
    const IconButton = ({ label, glyph, size = 14, onClick, className }) => h(
      'button',
      {
        type: 'button',
        className: cx('dwg-iconBtn', className),
        'aria-label': label,
        title: label,
        tabIndex: -1,
        onClick: (event) => { event.stopPropagation(); onClick(event) },
      },
      h(Glyph, { paths: glyph, size }),
    )

    /*
     * Toolbar and control glyphs, all Tabler outline paths (MIT — see NOTICE.md).
     *
     * The header's fourth control collapses every group. Tabler has no literal
     * "collapse tree" glyph; `fold`, `fold-up` and `arrows-minimize` all carry
     * four or eight small strokes that turn into a smear at 14px. `chevrons-up`
     * is the one that still reads as a shape at this size, and "fold everything
     * up" is what the button does.
     */
    const PLUS = ['M12 5l0 14', 'M5 12l14 0']
    const DOTS = ['M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0']
    const SEARCH = ['M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6']
    const FOLDER_PLUS = ['M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3.5', 'M16 19h6', 'M19 16v6']
    const VIEW_GRID = [
      'M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
      'M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
      'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
      'M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
    ]
    const VIEW_LIST = ['M9 6l11 0', 'M9 12l11 0', 'M9 18l11 0', 'M5 6l0 .01', 'M5 12l0 .01', 'M5 18l0 .01']
    const CLOSE = ['M18 6l-12 12', 'M6 6l12 12']
    const COLLAPSE = ['M7 11l5 -5l5 5', 'M7 17l5 -5l5 5']
    const CHEVRON_RIGHT = ['M9 6l6 6l-6 6']

    /**
     * Where a click wants its popup: the lower-left corner of the control that
     * opened it. Returning undefined (no layout in a test runtime, or a detached
     * node) is legal — the menu then falls back to the viewport corner.
     */
    const pointOf = (element) => {
      try {
        const rect = element?.getBoundingClientRect?.()
        if (rect === undefined || rect === null) return undefined
        return { x: Math.round(rect.left), y: Math.round(rect.bottom) + 2 }
      } catch {
        return undefined
      }
    }

    /**
     * Per-row hover controls: optionally "new conversation", always the row menu.
     *
     * The event is forwarded so the menu can anchor on the button that opened
     * it; without it `onMenu()` would be called with no point and every popup
     * would land in the viewport's top-left corner.
     */
    const RowActions = ({ t, onNew, onMenu }) => h(
      'span',
      { className: 'dwg-rowActions' },
      onNew === undefined ? null : h(IconButton, { label: t('act.newSession'), glyph: PLUS, onClick: onNew }),
      h(IconButton, {
        label: t('act.more'),
        glyph: DOTS,
        className: 'dwg-iconBtnMenu',
        onClick: event => onMenu(pointOf(event?.currentTarget)),
      }),
    )

    /** One conversation row. */
    const SessionRow = ({ node, t, selected, reveal, onOpen, onMenu }) => {
      const ref = useRef(null)
      useEffect(() => {
        if (reveal === undefined || ref.current === null) return
        ref.current.scrollIntoView({ block: 'nearest' })
      }, [reveal])
      const label = node.title.length > 0 ? node.title : node.blank ? t('row.blank') : t('row.untitled')
      const status = primaryStatus(node)
      return h(
        'div',
        {
          ref,
          className: cx('dwg-row', 'dwg-rowSession', node.archived && 'dwg-rowArchived', selected && 'dwg-rowSelected'),
          role: 'treeitem',
          'aria-level': 3,
          'aria-label': t('a11y.session', { name: label }),
          tabIndex: 0,
          'data-dwg-session': node.id,
          onClick: onOpen,
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            event.stopPropagation()
            onOpen()
          },
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
            onMenu({ x: event.clientX, y: event.clientY })
          },
        },
        h('span', { className: 'dwg-leading' },
          status === 'idle' ? null : h(StateDot, { state: status }),
          node.pinned ? h('span', { className: 'dwg-pinMark', 'aria-hidden': 'true' }) : null),
        h('span', { className: 'dwg-title' }, label),
        h('span', { className: 'dwg-time' }, relativeTime(node.updatedAt, t)),
      )
    }

    /**
     * One project row, with its conversation preview while expanded.
     *
     * `sectionKey` makes the row a drop target for the section it belongs to:
     * dragging a project onto a sibling project is the most natural "put it in
     * this group" gesture, and without it the row would light up on hover and
     * then do nothing on release — a dead affordance that reads as a bug. The
     * HIGHLIGHT still uses `project.key` so the row itself lights up.
     */
    const ProjectRow = ({ project, t, reveal, drag, handlers, sectionKey }) => h(
      'div',
      {
        className: 'dwg-block',
        onDragOver: event => handlers.dragOver(event, project.key),
        onDragLeave: event => handlers.dragLeave(event, project.key),
        onDrop: event => handlers.drop(event, sectionKey ?? project.key),
      },
      h(
        'div',
        {
          className: cx('dwg-row', 'dwg-rowProject', drag.over === project.key && 'dwg-rowDrop'),
          role: 'treeitem',
          'aria-level': 2,
          'aria-expanded': project.expanded ? 'true' : 'false',
          'aria-label': t('a11y.project', { name: project.title, n: project.count }),
          tabIndex: 0,
          'data-dwg-project': project.workspaceId,
          draggable: true,
          onClick: handlers.toggle,
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            handlers.toggle()
          },
          onDragStart: event => handlers.beginDrag(event, { kind: 'project', workspaceId: project.workspaceId, title: project.title }),
          onDragEnd: handlers.endDrag,
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
            handlers.menu({ x: event.clientX, y: event.clientY })
          },
        },
        h(Chevron, { open: project.expanded }),
        h(GroupGlyph, { icon: 'folder', className: 'dwg-glyphMuted' }),
        h('span', { className: 'dwg-title' }, project.title),
        project.count > 0 ? h('span', { className: 'dwg-count' }, String(project.count)) : null,
        h(RowActions, { t, onNew: handlers.newSession, onMenu: point => handlers.menu(point) }),
      ),
      project.expanded
        ? h(
          'div',
          { className: 'dwg-children' },
          project.visible.length === 0
            ? h('div', { className: 'dwg-hint' }, t('row.empty'))
            : project.visible.map(node => h(SessionRow, {
              key: node.key,
              node,
              t,
              selected: reveal !== undefined && reveal.sessionKey === node.key,
              reveal: reveal !== undefined && reveal.sessionKey === node.key ? reveal.tick : undefined,
              onOpen: () => handlers.openSession(node),
              onMenu: point => handlers.sessionMenu(node, point),
            })),
          project.hidden > 0
            ? h('button', { type: 'button', className: 'dwg-moreBtn', onClick: (event) => { event.stopPropagation(); handlers.showAll() } },
              t('row.showAll', { n: project.count }))
            : null,
          project.showAll
            ? h('button', { type: 'button', className: 'dwg-moreBtn', onClick: (event) => { event.stopPropagation(); handlers.showLess() } },
              t('row.showLess'))
            : null,
        )
        : null,
    )

    /** One group header and, while open, its project rows. */
    const GroupSection = ({ group, t, drag, handlers, children }) => h(
      'div',
      { className: 'dwg-group' },
      h(
        'div',
        {
          className: cx(
            'dwg-row',
            'dwg-rowGroup',
            `dwg-accent-${group.color}`,
            drag.over === group.key && 'dwg-rowDrop',
            drag.over === group.key && 'dwg-rowDropInside',
          ),
          role: 'treeitem',
          'aria-level': 1,
          'aria-expanded': group.collapsed ? 'false' : 'true',
          'aria-label': t('a11y.group', { name: group.name, n: group.count }),
          tabIndex: 0,
          'data-dwg-group': group.id,
          'data-dwg-accent': group.color,
          draggable: true,
          onClick: handlers.toggle,
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            handlers.toggle()
          },
          onDragStart: event => handlers.beginDrag(event, { kind: 'group', groupId: group.id, title: group.name }),
          onDragEnd: handlers.endDrag,
          onDragOver: event => handlers.dragOver(event, group.key),
          onDragLeave: event => handlers.dragLeave(event, group.key),
          onDrop: event => handlers.drop(event, group.key),
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
            handlers.menu({ x: event.clientX, y: event.clientY })
          },
        },
        h('span', { className: 'dwg-accentBar', 'aria-hidden': 'true' }),
        h(Chevron, { open: !group.collapsed }),
        h(GroupGlyph, { icon: group.icon, className: 'dwg-glyphAccent' }),
        h('span', { className: 'dwg-title' }, group.name),
        group.count > 0 ? h('span', { className: 'dwg-count' }, String(group.count)) : null,
        badgeText(group, t) === ''
          ? null
          : h('span', { className: cx('dwg-badge', group.pending > 0 && 'dwg-badgeWarn', group.running > 0 && 'dwg-badgeRun') }, badgeText(group, t)),
        h(RowActions, { t, onMenu: point => handlers.menu(point) }),
      ),
      group.collapsed
        ? null
        : h(
          'div',
          {
            className: 'dwg-body',
            onDragOver: event => handlers.dragOver(event, group.key),
            onDragLeave: event => handlers.dragLeave(event, group.key),
            onDrop: event => handlers.drop(event, group.key),
          },
          group.allProjects.length === 0
            ? h('div', { className: 'dwg-empty' }, t('empty.group'))
            : children,
        ),
    )

    /**
     * The "not in any group" bucket: a drop surface plus the loose projects.
     *
     * `separated` draws the rule ABOVE this section. It is passed in rather than
     * baked into the class because Ungrouped is always last and may also be
     * first: with no groups at all, an unconditional top border becomes a
     * stray rule above the very first row. The band rule under the pinned
     * section makes the same decision from the other side (see renderBody), so
     * one seam never gets painted twice.
     */
    const UngroupedSection = ({ section, t, drag, handlers, separated, children }) => h(
      'div',
      { className: cx('dwg-group dwg-groupLoose', separated && 'dwg-groupLooseSep') },
      h(
        'div',
        {
          className: cx('dwg-row', 'dwg-rowGroup', 'dwg-rowLoose', drag.over === section.key && 'dwg-rowDrop'),
          role: 'treeitem',
          'aria-level': 1,
          'aria-label': t('section.ungrouped'),
          'data-dwg-group': section.key,
          onDragOver: event => handlers.dragOver(event, section.key),
          onDragLeave: event => handlers.dragLeave(event, section.key),
          onDrop: event => handlers.drop(event, section.key),
        },
        h(GroupGlyph, { icon: 'dot', className: 'dwg-glyphMuted' }),
        h('span', { className: 'dwg-title dwg-titleMuted' }, t('section.ungrouped')),
        section.count > 0 ? h('span', { className: 'dwg-count' }, String(section.count)) : null,
      ),
      h(
        'div',
        {
          className: 'dwg-body',
          onDragOver: event => handlers.dragOver(event, section.key),
          onDragLeave: event => handlers.dragLeave(event, section.key),
          onDrop: event => handlers.drop(event, section.key),
        },
        section.projects.length === 0
          ? h('div', { className: 'dwg-empty' }, t('empty.ungrouped'))
          : children,
      ),
    )

    /** The archived-groups drawer; collapsed until opened. */
    const ArchivedGroups = ({ groups, t, open, onToggle, onUnarchive }) => {
      if (groups.length === 0) return null
      return h(
        'div',
        { className: 'dwg-archived' },
        h(
          'button',
          { type: 'button', className: 'dwg-archivedHead', 'aria-expanded': open ? 'true' : 'false', onClick: onToggle },
          h(Chevron, { open }),
          h('span', null, `${t('section.archived')} (${groups.length})`),
        ),
        open
          ? groups.map(group => h(
            'div',
            { key: group.key, className: cx('dwg-row', 'dwg-rowArchived', `dwg-accent-${group.color}`) },
            h(GroupGlyph, { icon: group.icon, className: 'dwg-glyphAccent' }),
            h('span', { className: 'dwg-title' }, group.name),
            h('button', { type: 'button', className: 'dwg-miniBtnWide', onClick: () => onUnarchive(group) }, t('act.unarchive')),
          ))
          : null,
      )
    }

    /** One search hit, always showing the group or project that owns it. */
    const SearchRow = ({ hit, t, path, onPick }) => h(
      'div',
      {
        className: cx('dwg-row', 'dwg-rowSession', 'dwg-rowSearch', hit.group !== null && hit.group !== undefined && `dwg-accent-${hit.group.color}`),
        role: 'button',
        tabIndex: 0,
        onClick: onPick,
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          onPick()
        },
      },
      h('span', { className: 'dwg-leading' }, hit.kind === 'group'
        ? h(GroupGlyph, { icon: hit.group?.icon, className: 'dwg-glyphAccent' })
        : hit.kind === 'project'
          ? h(GroupGlyph, { icon: 'folder', className: 'dwg-glyphMuted' })
          : null),
      h('span', { className: 'dwg-title' }, hit.title.length > 0 ? hit.title : t('row.untitled')),
      h('span', { className: 'dwg-path' }, t('search.path', { path })),
    )

    // ═══════════════════════════════════════════════════════════════════
    // Local popup menu
    //
    // The region owns the menus of its own rows: right-clicking a group header
    // or a project row opens this component, which is what makes
    // "移动到组 →" a real submenu without reaching into another plugin's private
    // menu internals. Conversation rows are the exception on purpose — their
    // menu is the shipped DSH one, opened through the public
    // `contextMenus.open({ kind: 'session', … })`, so pin / rename / fork /
    // archive / copy-id stay the built-in implementations.
    // ═══════════════════════════════════════════════════════════════════

    /** One actionable row, or a separator line. */
    const MenuRow = ({ item, onActivate, onHover }) => {
      const children = Array.isArray(item.children) && item.children.length > 0
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: cx('dwg-menuItem', item.danger === true && 'dwg-menuItemDanger'),
          disabled: item.disabled === true,
          onClick: (event) => {
            event.stopPropagation()
            if (children) onHover(item)
            else onActivate(item)
          },
          onMouseEnter: () => { if (children) onHover(item) },
          onFocus: () => { if (children) onHover(item) },
        },
        h('span', { className: 'dwg-menuLabel' }, item.label),
        item.checked === true ? h('span', { className: 'dwg-menuMark', 'aria-hidden': 'true' }, '✓') : null,
        children ? h('span', { className: 'dwg-menuArrow', 'aria-hidden': 'true' }, '›') : null,
      )
    }

    /**
     * A positioned menu with an optional one-level submenu. Keyboard support is
     * deliberately small and self-contained: Escape closes, ArrowUp/ArrowDown
     * move focus, Enter activates. It renders through a portal on document.body
     * so neither the sidebar's clipping nor its stacking context can cut it off.
     */
    const PopupMenu = ({ menu, anchor, onClose }) => {
      const root = useRef(null)
      const [openSub, setOpenSub] = useState(null)
      const submenu = openSub === null ? null : menu.items.find(item => item.id === openSub)

      /**
       * Placement is measured, not guessed at the anchor alone.
       *
       * The menu's height depends on its item count, and a menu opened near the
       * bottom of the viewport must open upwards rather than be clipped. So the
       * first pass renders fully transparent at the requested spot, the layout
       * effect below reads the real box, and the second pass paints it clamped
       * inside the viewport. Rendering at the wrong place and correcting it
       * afterwards would be a visible jump, so the first pass is never seen.
       *
       * A zero-size measurement (jsdom, or a host without layout) falls back to
       * the nominal size, so the menu is still placed, never stuck invisible.
       */
      const MENU_WIDTH = 228
      const MENU_ESTIMATED_HEIGHT = 280
      const MENU_MARGIN = 8
      const [box, setBox] = useState(null)

      useEffect(() => {
        root.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus?.({ preventScroll: true })
      }, [])

      /**
       * Measure, then place. A layout effect is the right hook: it runs after
       * the DOM exists but BEFORE the frame is painted, so the clamped position
       * is the first thing the user sees — an ordinary effect would paint the
       * hidden guess first and then move, which reads as a jump.
       *
       * `useLayoutEffect` is used unconditionally because this bundle only ever
       * runs in a browser; a string-rendering test runtime supplies a stub for
       * it, and React itself falls back to an effect outside a DOM.
       */
      useLayoutEffect(() => {
        const element = root.current
        if (element === null || typeof element.getBoundingClientRect !== 'function') return
        const rect = element.getBoundingClientRect()
        const width = rect.width > 0 ? rect.width : MENU_WIDTH
        const height = rect.height > 0 ? rect.height : MENU_ESTIMATED_HEIGHT
        // A runtime without a viewport (or with a nonsense one) must not produce
        // NaN coordinates: those render as `top: NaN` and place nothing at all.
        const viewWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 0
        const viewHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 0
        const wantLeft = anchor === undefined || anchor === null || !Number.isFinite(anchor.x) ? MENU_MARGIN : anchor.x
        const wantTop = anchor === undefined || anchor === null || !Number.isFinite(anchor.y) ? MENU_MARGIN : anchor.y
        const left = viewWidth > 0
          ? Math.max(MENU_MARGIN, Math.min(wantLeft, viewWidth - width - MENU_MARGIN))
          : Math.max(MENU_MARGIN, wantLeft)
        const top = viewHeight > 0
          ? Math.max(MENU_MARGIN, Math.min(wantTop, viewHeight - height - MENU_MARGIN))
          : Math.max(MENU_MARGIN, wantTop)
        setBox(current => (current !== null && current.left === left && current.top === top ? current : { left, top }))
      }, [anchor])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const scope = openSub === null ? root.current : root.current?.querySelector(`[data-submenu="${openSub}"]`)
          const rows = [...(scope?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [])]
          if (rows.length === 0) return
          const at = rows.indexOf(document.activeElement)
          const step = event.key === 'ArrowDown' ? 1 : -1
          rows[(at + step + rows.length) % rows.length]?.focus?.({ preventScroll: true })
        }
        window.addEventListener('keydown', onKey, true)
        return () => { window.removeEventListener('keydown', onKey, true) }
      }, [onClose, openSub])

      useEffect(() => {
        const onDown = (event) => {
          if (event.target instanceof Node && root.current?.contains(event.target) === true) return
          onClose()
        }
        window.addEventListener('pointerdown', onDown, true)
        return () => { window.removeEventListener('pointerdown', onDown, true) }
      }, [onClose])

      /**
       * First paint goes to the corner but is invisible; the measure pass above
       * then commits the clamped position. `box === null` means "not measured
       * yet", so the box must not be seen — and it must not swallow a click
       * either, hence `pointer-events:none` on that pass. Opacity (not
       * `visibility:hidden`) is deliberate: a visibility-hidden element cannot
       * take focus in a real browser, and the focus effect below moves focus
       * into the menu.
       */
      const style = box === null
        ? { visibility: 'visible', opacity: 0, pointerEvents: 'none', top: 0, left: 0 }
        : { top: box.top, left: box.left }

      const pick = (item) => {
        onClose()
        try {
          item.run?.()
        } catch (error) {
          console.error('dsh-workspace-groups: menu action failed', error)
        }
      }

      const list = (items, keyPrefix, withSubmenu) => items.map((item, index) => (item.separatorBefore === true
        ? h('div', { key: `${keyPrefix}sep:${index}`, className: 'dwg-menuSep', role: 'separator' })
        : h('div', { key: `${keyPrefix}${item.id}:${index}`, className: 'dwg-menuSlot' }, h(MenuRow, {
          item,
          onActivate: pick,
          ...(withSubmenu ? { onHover: target => setOpenSub(target.id) } : {}),
        }))))

      const body = h(
        'div',
        {
          ref: root,
          className: 'dwg-menu',
          role: 'menu',
          'aria-label': menu.label,
          style: { position: 'fixed', width: MENU_WIDTH, ...style },
          onClick: event => event.stopPropagation(),
          onContextMenu: event => event.preventDefault(),
        },
        list(menu.items, '', true),
        submenu !== null && Array.isArray(submenu.children)
          ? h('div', { className: 'dwg-submenu', role: 'menu', 'data-submenu': submenu.id }, list(submenu.children, 'sub', false))
          : null,
      )
      return ReactDOM?.createPortal === undefined ? body : ReactDOM.createPortal(body, document.body)
    }

    // ═══════════════════════════════════════════════════════════════════
    // Dialog
    // ═══════════════════════════════════════════════════════════════════

    /**
     * The one modal this region owns. Three shapes:
     *   - name: create group / rename group / rename project;
     *   - delete group: two mutually exclusive outcomes, with the SAFE one
     *     (dissolve — projects return to Ungrouped) preselected, so the
     *     destructive branch needs a second, explicit choice;
     *   - delete project: a single confirmation.
     */
    /** A 10-column swatch grid is the widest that fits a 360px dialog body. */
    const ICON_GRID_COLUMNS = 10

    /**
     * One dialog for every group edit: create, and rename + recolour + re-icon.
     *
     * The three properties used to live in three places — a name dialog, a
     * "颜色 →" submenu and an "图标 →" submenu — which meant changing a group's
     * look took three menu trips and no single place showed the current
     * combination. They describe one object (a folder's appearance), so they
     * belong in one form, exactly like a file manager's folder properties sheet.
     *
     * Icon and colour are still PRESETS, not free choice: a fixed palette keeps
     * every accent legible in both themes, which a colour wheel cannot promise.
     */
    const Dialog = ({ draft, t, busy, onCancel, onSubmit }) => {
      const editing = draft.kind === 'renameGroup'
      const [name, setName] = useState(draft.kind === 'create' ? '' : (draft.name ?? ''))
      const [color, setColor] = useState(draft.color ?? 'blue')
      const [icon, setIcon] = useState(draft.icon ?? 'folder')
      const [withProjects, setWithProjects] = useState(false)
      const input = useRef(null)

      useEffect(() => {
        input.current?.focus?.({ preventScroll: true })
      }, [draft.kind])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
        window.addEventListener('keydown', onKey, true)
        return () => { window.removeEventListener('keydown', onKey, true) }
      }, [onCancel])

      const title = draft.kind === 'create'
        ? t('dlg.newGroupTitle')
        : draft.kind === 'renameGroup'
          ? t('dlg.editGroupTitle')
          : draft.kind === 'renameProject'
            ? t('dlg.renameProjectTitle')
            : draft.kind === 'deleteGroup'
              ? t('dlg.deleteGroupTitle', { name: draft.name ?? '' })
              : t('dlg.deleteProjectTitle', { name: draft.name ?? '' })

      /** The appearance half is shown while creating and while editing a group. */
      const appearance = draft.kind === 'create' || editing
      const needsName = draft.kind === 'create' || editing || draft.kind === 'renameProject'
      const deleting = draft.kind === 'deleteGroup' || draft.kind === 'deleteProject'
      const canSubmit = !busy && (needsName ? name.trim().length > 0 : true)
      /** The live preview follows the swatch grid, so a pick is visible before Save. */
      const accent = PALETTE[color][0]

      const submit = (event) => {
        event?.preventDefault?.()
        if (!canSubmit) return
        onSubmit(draft.kind === 'deleteGroup'
          ? { withProjects }
          : appearance
            ? { name: name.trim(), color, icon }
            : { name: name.trim() })
      }

      const body = h(
        'div',
        { className: 'dwg-scrim', onClick: (event) => { event.stopPropagation(); onCancel() } },
        h(
          'form',
          {
            className: cx('dwg-dialog', appearance && 'dwg-dialogWide'),
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            onSubmit: submit,
            onClick: event => event.stopPropagation(),
          },
          h('div', { className: 'dwg-dialogTitle' }, title),
          needsName
            ? h(
              'label',
              { className: 'dwg-field' },
              h('span', { className: 'dwg-fieldLabel' }, t('dlg.name')),
              h('input', {
                ref: input,
                className: 'dwg-input',
                type: 'text',
                maxLength: NAME_MAX,
                value: name,
                placeholder: draft.kind === 'create' ? t('dlg.namePlaceholder') : '',
                onChange: event => setName(event.target.value),
              }),
            )
            : null,
          appearance
            ? h(
              'div',
              { className: 'dwg-field' },
              h('span', { className: 'dwg-fieldLabel' }, t('dlg.icon')),
              h(
                'div',
                { className: 'dwg-iconGrid', role: 'group', 'aria-label': t('dlg.icon') },
                ICONS.map(key => h(
                  'button',
                  {
                    key,
                    type: 'button',
                    className: cx('dwg-iconCell', icon === key && 'dwg-iconCellOn'),
                    'aria-label': t(`icon.${key}`),
                    'aria-pressed': icon === key,
                    title: t(`icon.${key}`),
                    style: icon === key ? { color: accent } : undefined,
                    onClick: () => setIcon(key),
                  },
                  h(GroupGlyph, { icon: key, className: 'dwg-glyphCell' }),
                )),
              ),
            )
            : null,
          appearance
            ? h(
              'div',
              { className: 'dwg-field' },
              h('span', { className: 'dwg-fieldLabel' }, t('dlg.color')),
              h(
                'div',
                { className: 'dwg-colorRow', role: 'group', 'aria-label': t('dlg.color') },
                COLORS.map(key => h('button', {
                  key,
                  type: 'button',
                  className: cx('dwg-swatch', `dwg-accent-${key}`, color === key && 'dwg-swatchOn'),
                  'aria-label': t(`color.${key}`),
                  'aria-pressed': color === key,
                  title: t(`color.${key}`),
                  onClick: () => setColor(key),
                })),
              ),
            )
            : null,
          draft.kind === 'create' ? h('div', { className: 'dwg-dialogHint' }, t('dlg.newGroupHint')) : null,
          draft.kind === 'deleteGroup'
            ? h(
              'div',
              { className: 'dwg-choice' },
              h(
                'label',
                { className: cx('dwg-choiceRow', !withProjects && 'dwg-choiceRowOn') },
                h('input', { type: 'radio', name: 'dwg-delete-mode', checked: !withProjects, onChange: () => setWithProjects(false) }),
                h('span', { className: 'dwg-choiceText' },
                  h('span', { className: 'dwg-choiceTitle' }, t('dlg.deleteDissolve')),
                  h('span', { className: 'dwg-choiceHint' }, t('dlg.deleteDissolveHint'))),
              ),
              h(
                'label',
                { className: cx('dwg-choiceRow', 'dwg-choiceRowDanger', withProjects && 'dwg-choiceRowOn') },
                h('input', { type: 'radio', name: 'dwg-delete-mode', checked: withProjects, onChange: () => setWithProjects(true) }),
                h('span', { className: 'dwg-choiceText' },
                  h('span', { className: 'dwg-choiceTitle' }, t('dlg.deleteWithProjects')),
                  h('span', { className: 'dwg-choiceHint' }, t('dlg.deleteWithProjectsHint'))),
              ),
            )
            : null,
          draft.kind === 'deleteProject' ? h('div', { className: 'dwg-dialogHint' }, t('dlg.deleteProjectHint')) : null,
          h(
            'div',
            { className: 'dwg-dialogActions' },
            h('button', { type: 'button', className: 'dwg-btn', onClick: onCancel }, t('dlg.cancel')),
            h(
              'button',
              { type: 'submit', className: cx('dwg-btn', 'dwg-btnPrimary', deleting && 'dwg-btnDanger'), disabled: !canSubmit },
              busy ? '…' : deleting ? t('dlg.delete') : t('dlg.save'),
            ),
          ),
        ),
      )
      return ReactDOM?.createPortal === undefined ? body : ReactDOM.createPortal(body, document.body)
    }

    // ═══════════════════════════════════════════════════════════════════
    // The browsing region
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Owns the region: reads the standard hook seats, derives the model, and
     * renders the header, search, tree, menus and dialog. Every mutation either
     * reaches the Host document or one DSH client service; a rejection lands in
     * the notice bar instead of throwing into React.
     */
    const WorkspaceGroups = (props) => {
      const { wide, expandSidebar, useWorkspaces, useSessions, useSessionStatus, useSectionScroller, injected, t } = props

      /**
       * Wiring guard, before any Hook runs.
       *
       * A shadowing entry (`priority: -1`) that throws while rendering is
       * ABDICATED, not reported to the user: the cell silently falls back to the
       * shipped browser. So a mis-wired prop would look exactly like "the plugin
       * does nothing" — no exception anywhere the user can see. This branch
       * turns that silent class of failure into visible text on the page instead,
       * and it is what the smoke test pins: give the component the flat props
       * and the guard fires.
       *
       * It names the missing pieces rather than saying "something is wrong":
       * that sentence is the whole diagnosis a user can copy back.
       *
       * Returning before the first Hook is safe here because a prop-shape
       * mismatch is permanent for the life of the entry — the inject face is
       * computed once and cached per entry (`rootInjectCache`), so this branch
       * cannot flip back to the wired path on some later render and change the
       * Hook count under React.
       */
      const missing = []
      if (injected === null || injected === undefined) missing.push('injected')
      else if (typeof injected.data?.start !== 'function') missing.push('injected.data')
      if (typeof useSectionScroller !== 'function') missing.push('useSectionScroller')
      if (typeof t !== 'function') missing.push('t')
      if (missing.length > 0) {
        return h(
          'div',
          { className: 'dwg-root dwg-miswired', 'data-dwg-miswire': missing.join(','), role: 'alert' },
          typeof t === 'function' ? t('error.miswired', { missing: missing.join(' / ') }) : `dsh-workspace-groups: missing ${missing.join(' / ')}`,
        )
      }

      const { bindScrollerRef } = useSectionScroller()

      const document = useSnapshot(injected.data.source)
      const notice = useSnapshot(injected.notice)

      const workspaces = useWorkspaces(state => state.items)
      const archivedIds = useWorkspaces(state => state.archivedSessionIds)
      const pinnedIds = useWorkspaces(state => state.pinnedSessionIds)
      const sessions = useSessions(state => state)
      const statuses = useSessionStatus(state => state)

      const model = useMemo(
        () => deriveModel(workspaces, sessions, statuses, pinnedIds, archivedIds, document),
        [workspaces, sessions, statuses, pinnedIds, archivedIds, document],
      )
      const recent = useMemo(
        () => (model.view === 'recent' ? deriveRecent(workspaces, sessions, statuses, pinnedIds, archivedIds) : []),
        [model.view, workspaces, sessions, statuses, pinnedIds, archivedIds],
      )

      const [dialog, setDialog] = useState(null)
      const [busy, setBusy] = useState(false)
      const [query, setQuery] = useState('')
      const [settled, setSettled] = useState('')
      const [searchOpen, setSearchOpen] = useState(false)
      const [archivedOpen, setArchivedOpen] = useState(false)
      const [menu, setMenu] = useState(null)
      const [dragOver, setDragOver] = useState(null)
      /**
       * What is being dragged, as STATE rather than a ref.
       *
       * The Ungrouped strip is hidden while it is empty (see `showUngrouped`),
       * but a project drag needs it back: dropping there is the only pointer
       * gesture that takes a project out of a group. `dragRef` cannot drive
       * that, because a ref write does not re-render — the strip has to exist
       * before the pointer reaches it, not after the first dragover rescues it.
       */
      const [dragging, setDragging] = useState(null)
      const [reveal, setReveal] = useState(null)

      const treeRef = useRef(null)
      const searchRef = useRef(null)
      const dragRef = useRef(null)

      /**
       * The tree is the section's own scroller, so it must feed the sidebar's
       * wheel hand-off (`bindScrollerRef`) as well as this component's own
       * queries. Both refs are attached to the same element.
       */
      const bodyRef = useCallback((element) => {
        treeRef.current = element
        bindScrollerRef(element)
      }, [bindScrollerRef])

      useEffect(() => { void injected.data.start() }, [injected])

      useEffect(() => {
        const timer = window.setTimeout(() => setSettled(query), SEARCH_DEBOUNCE_MS)
        return () => { window.clearTimeout(timer) }
      }, [query])

      useEffect(() => {
        if (menu === null) return undefined
        const close = () => setMenu(null)
        window.addEventListener('resize', close)
        return () => { window.removeEventListener('resize', close) }
      }, [menu])

      const notify = useCallback((message) => {
        if (typeof message !== 'string' || message.length === 0) return
        injected.notify(message)
      }, [injected])

      /** Run one document mutation; a rejection becomes a notice. */
      const commit = useCallback((action, payload) => injected.data.mutate(action, payload).then(
        result => result,
        (error) => {
          notify(t('error.save', { message: reasonText(error) }))
          return null
        },
      ), [injected, notify, t])

      /** Run one DSH client-service call with the same failure discipline. */
      const service = useCallback(async (label, run) => {
        try {
          return await run()
        } catch (error) {
          notify(t(label, { message: reasonText(error) }))
          return undefined
        }
      }, [notify, t])

      /** New project: pick a directory, register it, then file it under a group. */
      const newProject = useCallback(async (groupId) => {
        const ui = injected.ui()
        const ws = injected.ws()
        if (ui === undefined || ws === undefined) {
          notify(t('dlg.createFailed', { message: 'service unavailable' }))
          return undefined
        }
        const path = await service('dlg.pickFailed', () => ui.pickDirectory())
        if (path === null || path === undefined) return undefined
        const created = await service('dlg.createFailed', () => ws.create({ path }))
        if (created === undefined) return undefined
        await commit('assignWorkspace', {
          workspaceId: created.workspaceId,
          groupId: typeof groupId === 'string' ? groupId : '',
          index: Number.MAX_SAFE_INTEGER,
        })
        return created.workspaceId
      }, [commit, injected, notify, service, t])

      const newSession = useCallback((workspaceId) => {
        const ui = injected.ui()
        if (ui === undefined) return
        ui.startSession(workspaceId)
      }, [injected])

      const openSession = useCallback((node) => {
        const ui = injected.ui()
        if (ui === undefined) return
        ui.openSession(node.id)
      }, [injected])

      /** Conversation rows get the shipped DSH menu, opened through the public service. */
      const openSessionMenu = useCallback((node, point) => {
        const menus = injected.menus()
        if (menus === undefined) return
        menus.open({ kind: SESSION_TARGET, value: { sessionId: node.id, displayTitle: node.title } }, point)
      }, [injected])

      const moveProject = useCallback((workspaceId, groupId) => commit('assignWorkspace', {
        workspaceId,
        groupId: typeof groupId === 'string' ? groupId : '',
        index: Number.MAX_SAFE_INTEGER,
      }), [commit])

      const reorderGroup = useCallback((groupId, pinned, peers, beforeGroupId) => commit('orderGroup', {
        groupId,
        pinned: pinned === true,
        order: peers,
        beforeGroupId: beforeGroupId ?? '',
      }), [commit])

      /**
       * Fold or unfold one group. The Host owns the resulting flag, so this
       * posts the DESIRED state rather than a "toggle" verb: two fast clicks
       * then cannot race each other into the wrong fold. It is declared here,
       * above every consumer — the group menu lists it in its dependency array
       * and the header wires it into a click handler.
       */
      const toggleGroup = useCallback((group) => {
        void commit('updateGroup', { groupId: group.id, collapsed: group.collapsed !== true })
      }, [commit])

      /* drag and drop --------------------------------------------------- */

      const beginDrag = useCallback((event, payload) => {
        dragRef.current = payload
        setDragging(payload)
        try {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', payload.title ?? '')
        } catch { /* a synthetic drag may not expose dataTransfer */ }
      }, [])

      const endDrag = useCallback(() => {
        dragRef.current = null
        setDragging(null)
        setDragOver(null)
      }, [])

      const handleDragOver = useCallback((event, key) => {
        const payload = dragRef.current
        if (payload === null) return
        event.preventDefault()
        event.stopPropagation()
        if (payload.kind === 'project') {
          try {
            event.dataTransfer.dropEffect = 'move'
          } catch { /* same as above */ }
        }
        setDragOver(key)
      }, [])

      const dragLeave = useCallback((event, key) => {
        const related = event.relatedTarget
        if (related instanceof Node && event.currentTarget?.contains?.(related) === true) return
        setDragOver(current => (current === key ? null : current))
      }, [])

      /** Drop on a section: a project joins it; a group is reordered before it. */
      const drop = useCallback((event, key) => {
        const payload = dragRef.current
        dragRef.current = null
        setDragging(null)
        setDragOver(null)
        if (payload === null) return
        event.preventDefault()
        event.stopPropagation()
        const groupId = key.startsWith('g:') ? key.slice(2) : ''
        if (payload.kind === 'project') {
          if (groupId === '') {
            if (key.startsWith('u:')) moveProject(payload.workspaceId, '')
            return
          }
          moveProject(payload.workspaceId, groupId)
          return
        }
        if (payload.kind !== 'group' || groupId === '') return
        const target = [...model.pinned, ...model.groups].find(section => section.id === groupId)
        if (target === undefined || target.id === payload.groupId) return
        const peers = (target.pinned ? model.pinned : model.groups)
          .filter(section => section.id !== payload.groupId)
          .map(section => section.id)
        reorderGroup(payload.groupId, target.pinned, peers, target.id)
      }, [model, moveProject, reorderGroup])

      /* search ---------------------------------------------------------- */

      const search = useMemo(
        () => deriveSearch(model, recent, settled, document.settings.searchLimit),
        [model, recent, settled, document.settings.searchLimit],
      )

      const clearSearch = useCallback(() => {
        setQuery('')
        setSettled('')
        setSearchOpen(false)
      }, [])

      /** Jump to a hit: open the owning node, then highlight and scroll to it. */
      const pickHit = useCallback(async (hit) => {
        let projectKey
        if (hit.kind === 'group') {
          await commit('updateGroup', { groupId: hit.group.id, collapsed: false })
        } else if (hit.project !== null && hit.project !== undefined) {
          projectKey = hit.project.key
          await commit('setWorkspaceState', { workspaceId: hit.project.workspaceId, expanded: true, showAll: true })
        }
        setReveal({
          projectKey,
          sessionKey: hit.session === null || hit.session === undefined ? undefined : hit.session.key,
          tick: Date.now(),
        })
        setQuery('')
        setSettled('')
        setSearchOpen(false)
      }, [commit])

      /* keyboard walk --------------------------------------------------- */

      useEffect(() => {
        if (reveal === null) return
        const id = reveal.sessionKey?.startsWith('s:') === true ? reveal.sessionKey.slice(2) : undefined
        const node = id === undefined ? null : treeRef.current?.querySelector(`[data-dwg-session="${id}"]`)
        node?.scrollIntoView?.({ block: 'nearest' })
      }, [reveal, model])

      const onTreeKeyDown = useCallback((event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        const target = event.target
        if (!(target instanceof HTMLElement)) return
        const rows = [...(treeRef.current?.querySelectorAll('.dwg-row[tabindex]') ?? [])]
        if (rows.length === 0) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const at = rows.indexOf(target)
          const step = event.key === 'ArrowDown' ? 1 : -1
          rows[(at + step + rows.length) % rows.length]?.focus?.({ preventScroll: true })
          return
        }
        // Left/Right fold or unfold whatever foldable row has focus.
        const groupId = target.dataset.dwgGroup
        const workspaceId = target.dataset.dwgProject
        if (groupId === undefined && workspaceId === undefined) return
        event.preventDefault()
        target.click()
      }, [])

      /* menus ----------------------------------------------------------- */

      const openDialog = useCallback(draft => setDialog(draft), [])

      const groupMenuItems = useCallback((group) => ({
        label: group.name,
        items: [
          {
            // The header click is the fast path; this row exists because the
            // header also toggles on a stray click while dragging, and a menu
            // entry is the only fold affordance a keyboard user can find.
            id: 'fold',
            label: group.collapsed === true ? t('menu.expand') : t('menu.collapse'),
            run: () => toggleGroup(group),
          },
          { id: 'newProject', label: t('menu.newProject'), run: () => { void newProject(group.id) } },
          { id: 'sep1', separatorBefore: true, label: '' },
          { id: 'edit', label: t('menu.editGroup'), run: () => openDialog({ kind: 'renameGroup', groupId: group.id, name: group.name, color: group.color, icon: group.icon }) },
          // Colour and icon now live in the edit dialog, not in two submenus: they
          // are two properties of one appearance sheet, and a submenu that only
          // sets one of them hides the current combination of both.
          {
            id: 'pin',
            label: group.pinned ? t('menu.unpin') : t('menu.pin'),
            run: () => {
              // Unpin: land at the head of the rest section (`peers[0]` is its
              // first row). Pin: land at the head of the pinned band, which is
              // exactly what "固定到顶部" promises.
              if (group.pinned) {
                const peers = model.groups.map(section => section.id).filter(id => id !== group.id)
                void reorderGroup(group.id, false, peers, peers[0] ?? '')
              } else {
                const peers = model.pinned.map(section => section.id).filter(id => id !== group.id)
                void reorderGroup(group.id, true, peers, peers[0] ?? '')
              }
            },
          },
          // No "调整顺序" submenu on purpose: dragging a group header onto another
          // header already reorders it within its section, and a menu that repeats
          // a gesture the tree teaches is one more list to keep correct. The drop
          // path is the single implementation; see §5 "拖动".
          { id: 'sep2', separatorBefore: true, label: '' },
          { id: 'archive', label: t('menu.archive'), run: () => { void commit('archiveGroup', { groupId: group.id }) } },
          { id: 'delete', label: t('menu.deleteGroup'), danger: true, run: () => openDialog({ kind: 'deleteGroup', groupId: group.id, name: group.name }) },
        ],
      }), [commit, model, newProject, openDialog, reorderGroup, t, toggleGroup])

      const projectMenuItems = useCallback((project) => ({
        label: project.title,
        items: [
          { id: 'newSession', label: t('menu.newSession'), run: () => newSession(project.workspaceId) },
          { id: 'sep1', separatorBefore: true, label: '' },
          {
            id: 'moveTo',
            label: t('menu.moveTo'),
            children: [
              ...(project.groupKey === UNGROUPED
                ? []
                : [{ id: 'move-out', label: t('menu.moveOut'), run: () => { void moveProject(project.workspaceId, '') } }]),
              ...model.pinned.concat(model.groups).map(section => ({
                id: `move-${section.id}`,
                label: section.name,
                checked: project.groupKey === section.id,
                run: () => { void moveProject(project.workspaceId, section.id) },
              })),
              ...(model.pinned.length + model.groups.length > 0 ? [] : [{ id: 'move-none', label: t('section.ungrouped'), disabled: true }]),
            ],
          },
          { id: 'rename', label: t('menu.renameProject'), run: () => openDialog({ kind: 'renameProject', workspaceId: project.workspaceId, name: project.title }) },
          { id: 'sep2', separatorBefore: true, label: '' },
          { id: 'delete', label: t('menu.deleteProject'), danger: true, run: () => openDialog({ kind: 'deleteProject', workspaceId: project.workspaceId, name: project.title }) },
        ],
      }), [model, moveProject, newSession, openDialog, t])

      /* dialog submit --------------------------------------------------- */

      const submitDialog = useCallback(async (values) => {
        const draft = dialog
        if (draft === null) return
        setBusy(true)
        try {
          if (draft.kind === 'create') {
            await commit('createGroup', { name: values.name, color: values.color, icon: values.icon })
          } else if (draft.kind === 'renameGroup') {
            await commit('updateGroup', {
              groupId: draft.groupId,
              name: values.name,
              color: values.color,
              icon: values.icon,
            })
          } else if (draft.kind === 'renameProject') {
            const ws = injected.ws()
            if (ws !== undefined) await service('dlg.renameFailed', () => ws.rename(draft.workspaceId, values.name))
          } else if (draft.kind === 'deleteGroup') {
            const group = [...model.pinned, ...model.groups].find(section => section.id === draft.groupId)
            if (group !== undefined) {
              if (values.withProjects === true) {
                const ws = injected.ws()
                if (ws !== undefined) {
                  for (const project of group.allProjects) {
                    await service('dlg.deleteFailed', () => ws.delete(project.workspaceId))
                  }
                }
              }
              await commit('deleteGroup', { groupId: group.id, withProjects: values.withProjects === true })
            }
          } else if (draft.kind === 'deleteProject') {
            const ws = injected.ws()
            if (ws !== undefined) await service('dlg.deleteFailed', () => ws.delete(draft.workspaceId))
          }
          setDialog(null)
        } finally {
          setBusy(false)
        }
      }, [commit, dialog, injected, model, service])

      /* render ---------------------------------------------------------- */

      const projectHandlers = useCallback(project => ({
        toggle: () => { void commit('setWorkspaceState', { workspaceId: project.workspaceId, expanded: project.expanded !== true }) },
        menu: (point) => { setMenu({ kind: 'project', project, anchor: point }) },
        newSession: () => newSession(project.workspaceId),
        openSession: node => openSession(node),
        sessionMenu: (node, point) => openSessionMenu(node, point),
        showAll: () => { void commit('setWorkspaceState', { workspaceId: project.workspaceId, showAll: true }) },
        showLess: () => { void commit('setWorkspaceState', { workspaceId: project.workspaceId, showAll: false }) },
        beginDrag,
        endDrag,
        dragOver: handleDragOver,
        dragLeave,
        drop,
      }), [beginDrag, commit, dragLeave, handleDragOver, drop, endDrag, newSession, openSession, openSessionMenu])

      /**
       * Project rows for one section. `sectionKey` is the section's own drop
       * key: a dropped project joins THAT group, including when it lands on a
       * sibling project rather than on the header.
       */
      const renderProjects = (items, sectionKey) => items.map(project => h(ProjectRow, {
        key: project.key,
        project,
        t,
        reveal: reveal !== null && reveal.projectKey === project.key ? reveal : undefined,
        drag: { over: dragOver },
        handlers: projectHandlers(project),
        sectionKey,
      }))

      /** Fold or unfold one group; the Host owns the resulting flag. */
      const dropHandlers = (handlers, fold) => ({
        beginDrag,
        endDrag,
        dragOver: handleDragOver,
        dragLeave,
        drop,
        menu: handlers,
        // A header click folds the group; the Ungrouped bucket has no fold state
        // and passes nothing, so its header stays a pure drop surface.
        ...(fold === undefined ? {} : { toggle: () => toggleGroup(fold) }),
      })

      /**
       * Is the Ungrouped bucket worth a row?
       *
       * An empty Ungrouped is dead weight: it is a heading with a dashed
       * placeholder under it, sitting where the eye expects more groups, and the
       * first thing a new user reads as "there is an empty section in here".
       * With no groups at all it is not even true — every project falls through
       * to it, so labelling the whole list "Ungrouped" carries no information.
       *
       * Two exceptions keep it alive:
       *  1. projects actually live there;
       *  2. a project is being dragged. Dropping onto the strip is the only
       *     POINTER gesture that takes a project out of a group, so the target
       *     must come back while the drag is possible. That is why `dragging`
       *     is state and not the `dragRef` — a ref write does not re-render, and
       *     a target that appears only after the pointer has already passed
       *     over it is a target the user cannot hit.
       */
      const showUngrouped = model.ungrouped.projects.length > 0
        || (dragging !== null && dragging.kind === 'project')

      const sections = [
        ...model.pinned.map(group => h(GroupSection, {
          key: group.key,
          group,
          t,
          drag: { over: dragOver, mode: 'inside' },
          handlers: dropHandlers(point => setMenu({ kind: 'group', group, anchor: point }), group),
          children: renderProjects(group.allProjects, group.key),
        })),
        ...model.groups.map(group => h(GroupSection, {
          key: group.key,
          group,
          t,
          drag: { over: dragOver, mode: 'inside' },
          handlers: dropHandlers(point => setMenu({ kind: 'group', group, anchor: point }), group),
          children: renderProjects(group.allProjects, group.key),
        })),
        ...(showUngrouped
          ? [h(UngroupedSection, {
            key: model.ungrouped.key,
            section: model.ungrouped,
            t,
            drag: { over: dragOver },
            handlers: dropHandlers(),
            separated: model.groups.length > 0,
            children: renderProjects(model.ungrouped.projects, model.ungrouped.key),
          })]
          : []),
      ]

      const menuModel = menu === null
        ? null
        : menu.kind === 'group'
          ? groupMenuItems(menu.group)
          : projectMenuItems(menu.project)

      const queryActive = settled.trim().length > 0
      const view = model.view
      /**
       * Loading means the Host has not answered the grouping document yet (and
       * no read failure is showing): painting the tree from the empty
       * placeholder would show every project under Ungrouped and then rearrange
       * itself, which the eye reads as a bug rather than as a load.
       */
      const loading = document.loaded !== true && document.readError === null && document.error === null
      const readFailed = document.loaded !== true && document.readError !== null

      /**
       * The collapsed rail. A rail is 49px wide: the tree cannot be shown, so
       * the region degrades to the three 36×36 controls that mirror the shell's
       * rail rhythm, and each of them EXPANDS the sidebar first — a control that
       * acted on a tree nobody can see would be a dead affordance.
       */
      if (!wide) {
        return h(
          'div',
          { className: 'dwg-root dwg-rootRail', 'data-dwg-region': '', 'aria-label': t('title') },
          h(IconButton, {
            label: t('search'),
            glyph: SEARCH,
            className: 'dwg-railBtn',
            onClick: () => {
              expandSidebar()
              setSearchOpen(true)
            },
          }),
          h(IconButton, {
            label: t('act.newProject'),
            glyph: FOLDER_PLUS,
            className: 'dwg-railBtn',
            onClick: () => { expandSidebar(); void newProject(null) },
          }),
          h(IconButton, {
            label: t('act.newGroup'),
            glyph: PLUS,
            className: 'dwg-railBtn',
            onClick: () => { expandSidebar() },
          }),
        )
      }

      const renderBody = () => {
        if (queryActive) {
          if (search.hits.length === 0) return h('div', { className: 'dwg-empty' }, t('search.none'))
          return h('div', null,
            search.hits.map((hit, index) => h(SearchRow, {
              key: `${hit.key}:${index}`,
              hit,
              t,
              path: hit.kind === 'group'
                ? hit.group.name
                : hit.project !== null && hit.project !== undefined
                  ? hit.project.title
                  : t('section.ungrouped'),
              onPick: () => { void pickHit(hit) },
            })),
            search.hasMore ? h('div', { className: 'dwg-hint' }, t('search.more', { n: document.settings.searchLimit })) : null,
          )
        }
        if (view === 'recent') {
          if (loading) return h('div', { className: 'dwg-hint' }, '…')
          if (recent.length === 0) return h('div', { className: 'dwg-empty' }, t('row.empty'))
          return recent.map(node => h(SessionRow, {
            key: node.key,
            node,
            t,
            selected: reveal !== null && reveal.sessionKey === node.key,
            reveal: reveal !== null && reveal.sessionKey === node.key ? reveal.tick : undefined,
            onOpen: () => openSession(node),
            onMenu: point => openSessionMenu(node, point),
          }))
        }
        // The grouped tree waits for the first Host answer; the placeholder
        // document would otherwise paint every project as Ungrouped. A failed
        // read gets its own face with the reason and a Retry, because a spinner
        // that never resolves is the worst of the three outcomes.
        if (readFailed) {
          return h('div', { className: 'dwg-failed' },
            h('div', { className: 'dwg-failedTitle' }, t('error.load', { message: document.readError })),
            h('button', {
              type: 'button',
              className: 'dwg-miniBtnWide',
              onClick: () => { void injected.data.start() },
            }, t('error.retry')),
          )
        }
        if (loading) return h('div', { className: 'dwg-hint dwg-loading' }, '…')
        /**
         * Nothing to show at all.
         *
         * With no projects, no groups and no archived groups, the tree would
         * otherwise be a single header strip — and since an empty Ungrouped is
         * now hidden, an entirely blank panel. A blank panel reads as a failed
         * load, so the truly empty case gets one line of orientation instead.
         *
         * Archived groups alone do not count: the drawer below still has
         * something to offer, so the tree keeps its normal (empty) shape. A
         * project drag cannot reach this branch either — for any project to be
         * draggable it must sit in a group (no groups) or in Ungrouped (not
         * empty), so both input sets here are already zero.
         */
        if (model.pinned.length === 0 && model.groups.length === 0
          && model.ungrouped.projects.length === 0 && model.archivedGroups.length === 0) {
          return h('div', { className: 'dwg-empty' }, t('tree.empty'))
        }
        /**
         * The rule under the pinned band.
         *
         * This used to be drawn from BOTH sides — the pinned band inserted its
         * own rule and Ungrouped carried an unconditional border-top — so with
         * every group pinned the two landed a few pixels apart and the seam
         * read as a stray double line. Now exactly one rule owns each seam: the
         * pinned band draws its own (it is the only band that can move), and
         * Ungrouped draws one only when a real group sits directly above it.
         * Its section is always last, so nothing else can close that seam.
         * `showUngrouped` — not `ungrouped.projects.length` — because the strip
         * can also be on screen while a project is dragged (it is the drop
         * target for leaving a group); the band rule has to know about the row
         * that is actually painted, or the strip appears with no seam above it.
         */
        return model.pinned.length > 0 && (model.groups.length > 0 || showUngrouped)
          ? [...sections.slice(0, model.pinned.length),
            h('div', { key: 'dwg-pinnedRule', className: 'dwg-pinnedRule', 'aria-hidden': 'true' }),
            ...sections.slice(model.pinned.length)]
          : sections
      }

      return h(
        'div',
        { className: 'dwg-root', 'data-dwg-region': '' },
        h(
          'div',
          { className: 'dwg-header' },
          h('span', { className: 'dwg-headerTitle' }, t('title')),
          h(
            'div',
            { className: 'dwg-headerActions' },
            h(IconButton, {
              label: searchOpen || query.length > 0 ? t('search.close') : t('search'),
              glyph: SEARCH,
              size: 16,
              className: cx('dwg-iconBtnHeader', (searchOpen || query.length > 0) && 'dwg-iconBtnOn'),
              // The same button opens AND closes the field: one permanent
              // affordance that does not move, rather than an open control plus
              // a separate dismiss control hidden somewhere else.
              onClick: () => {
                if (searchOpen || query.length > 0) {
                  clearSearch()
                  return
                }
                expandSidebar()
                setSearchOpen(true)
                window.setTimeout(() => searchRef.current?.focus?.({ preventScroll: true }), 0)
              },
            }),
            // 16px inside the 24px header box: Tabler's glyphs are drawn for a
            // 24px display, and at 14px the two chevrons of `collapseAll` merge
            // into one thick stroke while the rest lose their counters.
            h(IconButton, { label: t('act.newProject'), glyph: FOLDER_PLUS, size: 16, className: 'dwg-iconBtnHeader', onClick: () => { void newProject(null) } }),
            h(IconButton, { label: t('act.newGroup'), glyph: PLUS, size: 16, className: 'dwg-iconBtnHeader', onClick: () => openDialog({ kind: 'create' }) }),
            h(IconButton, { label: t('act.collapseAll'), glyph: COLLAPSE, size: 16, className: 'dwg-iconBtnHeader', onClick: () => { void commit('collapseAll', {}) } }),
          ),
        ),
        searchOpen || query.length > 0
          ? h(
            'div',
            { className: 'dwg-searchRow' },
            h(
              'div',
              { className: 'dwg-search' },
              h(Glyph, { paths: SEARCH, size: 13, className: 'dwg-searchIcon' }),
              h('input', {
                ref: searchRef,
                className: 'dwg-searchInput',
                type: 'text',
                value: query,
                placeholder: t('search.placeholder'),
                'aria-label': t('search'),
                onChange: event => setQuery(event.target.value),
                onFocus: () => setSearchOpen(true),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') clearSearch()
                  if (event.key === 'Enter') event.preventDefault()
                },
              }),
              query.length > 0
                ? h(IconButton, { label: t('search.clear'), glyph: CLOSE, className: 'dwg-searchClear', onClick: clearSearch })
                : null,
            ),
            h(IconButton, {
              label: view === 'recent' ? t('act.grouped') : t('act.recent'),
              glyph: view === 'recent' ? VIEW_GRID : VIEW_LIST,
              className: 'dwg-viewBtn',
              onClick: () => { void commit('setView', { view: view === 'recent' ? 'grouped' : 'recent' }) },
            }),
          )
          : null,
        notice === null ? null : h('div', { className: 'dwg-notice', role: 'status' }, notice),
        h(
          'div',
          { ref: bodyRef, className: 'dwg-body', role: queryActive ? 'list' : 'tree', 'aria-label': queryActive ? t('search.results') : t('a11y.tree'), onKeyDown: onTreeKeyDown },
          renderBody(),
          view === 'grouped' && !queryActive
            ? h(ArchivedGroups, {
              groups: model.archivedGroups,
              t,
              open: archivedOpen,
              onToggle: () => setArchivedOpen(value => !value),
              onUnarchive: group => { void commit('unarchiveGroup', { groupId: group.id }) },
            })
            : null,
        ),
        menuModel === null ? null : h(PopupMenu, { menu: menuModel, anchor: menu?.anchor, onClose: () => setMenu(null) }),
        dialog === null ? null : h(Dialog, { draft: dialog, t, busy, onCancel: () => setDialog(null), onSubmit: values => { void submitDialog(values) } }),
      )
    }

    // ═══════════════════════════════════════════════════════════════════
    // Stylesheet
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Global CSS, contained by contract: every selector is qualified by one of
     * this plugin's own `dwg-` classes, so no other surface can be touched.
     *
     * Chrome colours are harness theme tokens with no literal fallbacks, so a
     * renamed token degrades appearance instead of breaking rendering. The ten
     * accents are the only literal colours, and each has a `light`/`dark` pair:
     * the dark half is applied under `body[data-ds-dark-theme]`, the attribute
     * the theme presenter sets. Geometry follows the shipped sidebar metrics —
     * 32px rows, 8px inline padding, 12px radius, 14/20px titles, 10/16px meta.
     */
    const CSS = `
.dwg-root{--dwg-accent:${PALETTE.blue[0]};box-sizing:border-box;display:flex;flex-direction:column;min-height:0;height:100%;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}
.dwg-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 8px 6px;flex:0 0 auto}
/* Rail variant: the collapsed sidebar is 49px wide, so the tree is not
   rendered at all; these three controls mirror the shell rail's 36px rhythm and
   each of them expands the sidebar before acting. The doubled class is
   deliberate: the 20px base rule sits LATER in this sheet, so a single-class
   selector would lose to it and every rail button would render at 20px. */
.dwg-rootRail{gap:8px;padding-top:2px;align-items:flex-start}
.dwg-iconBtn.dwg-railBtn{width:36px;height:36px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary)}
.dwg-railBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwg-headerTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dwg-headerActions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
.dwg-iconBtn.dwg-iconBtnHeader{width:24px;height:24px;border-radius:6px}
.dwg-iconBtnOn{color:var(--dsw-alias-state-business-primary)}
.dwg-searchRow{display:flex;align-items:center;gap:4px;padding:0 8px 6px;flex:0 0 auto}
.dwg-search{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;height:28px;padding:0 6px;box-sizing:border-box;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1)}
.dwg-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dwg-searchIcon{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
.dwg-searchInput{flex:1 1 auto;min-width:0;height:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit;padding:0}
/* Focus feedback lives on the rounded container (:focus-within), which is the
   shipped input convention. The input's own square ring is a different shape
   inside an 8px-radius box and reads as a glitch, so it is suppressed. Two
   selectors because the platform's global :focus-visible rule would otherwise
   still paint after this one. */
.dwg-searchInput:focus,.dwg-searchInput:focus-visible{outline:0}
.dwg-searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}
/* Every variant that resizes the shared 20px base must name BOTH classes: the
   base rule sits later in this sheet, so an equal-specificity selector loses
   and the control silently renders 20px. */
.dwg-iconBtn.dwg-searchClear{width:18px;height:18px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dwg-iconBtn.dwg-viewBtn{width:28px;height:28px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dwg-iconBtn.dwg-viewBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwg-notice{margin:0 8px 6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;flex:0 0 auto;word-break:break-word}
.dwg-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;margin-left:-4px;padding:0 4px 12px;scrollbar-width:thin}
.dwg-group{display:flex;flex-direction:column}
/* Ungrouped sits last. The top rule belongs to the section only when a real
   group is directly above it: the pinned band already owns the seam under
   itself, and with no groups at all there is no seam to draw. Painting both
   sides is what produced two rules a few pixels apart. */
.dwg-groupLoose{margin-top:3px;padding-top:3px}
.dwg-groupLooseSep{border-top:1px solid var(--dsw-alias-border-l2)}
.dwg-block{display:flex;flex-direction:column}
.dwg-row{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:12px;cursor:pointer;color:var(--dsw-alias-label-primary);user-select:none;position:relative}
.dwg-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwg-rowSelected{background:var(--dsw-alias-interactive-bg-hover)}
.dwg-rowDrop{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dwg-rowGroup{font-weight:600}
.dwg-rowLoose{font-weight:500;height:28px;color:var(--dsw-alias-label-secondary)}
.dwg-rowArchived{opacity:.66}
.dwg-rowSession{height:30px;padding-left:22px}
.dwg-rowProject{padding-left:4px}
.dwg-accentBar{position:absolute;left:2px;top:7px;bottom:7px;width:2px;border-radius:2px;background:var(--dwg-accent);flex:0 0 auto}
.dwg-chevron{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.dwg-chevronOpen{transform:rotate(90deg)}
.dwg-glyph{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
/* Icon base: every glyph in this region is a Tabler 24-grid outline, so one
   rule sets the box and no caller has to remember a viewBox. */
.dwg-glyphIc{flex:0 0 auto;display:block}
/* The picker draws at 16px inside a 30px cell; the row header keeps 14px. */
.dwg-glyphCell{width:16px;height:16px}
.dwg-glyphAccent{color:var(--dwg-accent)}
.dwg-glyphMuted{color:var(--dsw-alias-label-tertiary)}
.dwg-glyphDot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dwg-accent)}
.dwg-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.dwg-titleMuted{color:var(--dsw-alias-label-secondary);font-weight:500;font-size:12px;line-height:18px}
.dwg-count{flex:0 0 auto;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dwg-time{flex:0 0 auto;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dwg-path{flex:0 0 auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dwg-badge{flex:0 0 auto;padding:0 5px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;font-variant-numeric:tabular-nums}
.dwg-badgeRun{color:var(--dsw-alias-state-business-primary)}
.dwg-badgeWarn{color:var(--dsw-alias-state-warn-primary)}
.dwg-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dwg-dot-done{background:var(--dsw-alias-state-success-primary)}
.dwg-dot-warning{background:var(--dsw-alias-state-warn-primary)}
.dwg-dot-ongoing{background:var(--dsw-alias-state-business-primary)}
.dwg-leading{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;min-width:0}
.dwg-pinMark{display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.dwg-pinnedRule{height:1px;margin:4px 8px 2px;background:var(--dsw-alias-border-l2)}
.dwg-rowActions{display:none;align-items:center;gap:2px;flex:0 0 auto}
.dwg-iconBtn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:20px;height:20px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dwg-iconBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dwg-row:hover .dwg-rowActions,.dwg-row:focus-within .dwg-rowActions{display:inline-flex}
.dwg-children{display:flex;flex-direction:column}
.dwg-hint{padding:2px 8px 6px 26px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dwg-loading{display:flex;align-items:center;gap:6px;padding:10px 12px;color:var(--dsw-alias-label-tertiary)}
.dwg-failed{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin:4px 4px 8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
/* Wiring guard: renderer-shape mismatch, which a shadowing entry would otherwise swallow silently. */
.dwg-miswired{display:block;margin:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px;word-break:break-word}
.dwg-failedTitle{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dwg-empty{margin:2px 0 6px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;text-align:center}
.dwg-moreBtn{align-self:flex-start;margin:0 0 4px 22px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;padding:2px 6px;border-radius:6px}
.dwg-moreBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwg-miniBtnWide{box-sizing:border-box;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;flex:0 0 auto}
.dwg-miniBtnWide:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwg-archived{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.dwg-archivedHead{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;padding:0 8px;text-align:left}
.dwg-archivedHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwg-menu{box-sizing:border-box;display:flex;flex-direction:column;gap:1px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgb(0 0 0 / 18%);z-index:1000}
.dwg-submenu{position:absolute;top:-5px;left:100%;margin-left:4px;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgb(0 0 0 / 18%);min-width:180px;max-height:min(60vh,420px);overflow-y:auto}
.dwg-menuSlot{position:relative;display:flex;flex-direction:column}
.dwg-menuItem{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;padding:0 8px;text-align:left}
.dwg-menuItem:hover:not(:disabled),.dwg-menuItem:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:0}
.dwg-menuItem:disabled{opacity:.55;cursor:default}
.dwg-menuItemDanger{color:var(--dsw-alias-state-error-primary)}
.dwg-menuLabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwg-menuMark,.dwg-menuArrow{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
.dwg-menuSep{height:1px;margin:3px 2px;background:var(--dsw-alias-border-l2)}
.dwg-scrim{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgb(0 0 0 / 32%);z-index:1100}
.dwg-dialog{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:min(360px,calc(100vw - 32px));padding:16px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 16px 48px rgb(0 0 0 / 24%)}
/* The appearance sheet needs room for a 10-column swatch grid without the icons
   crushed into 20px cells. */
.dwg-dialogWide{width:min(400px,calc(100vw - 32px))}
.dwg-dialogTitle{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dwg-field{display:flex;flex-direction:column;gap:4px}
.dwg-fieldLabel{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.dwg-input{box-sizing:border-box;height:30px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.dwg-input:focus{outline:0;border-color:var(--dsw-alias-state-business-primary)}
/* Preset pickers: a fixed grid, not a free picker. Ten columns of 30px cells fit
   the 400px sheet with its 16px padding; the swatch row below reuses the same
   rhythm so the two groups read as one form. */
.dwg-iconGrid{display:grid;grid-template-columns:repeat(10,1fr);gap:2px}
.dwg-iconCell{display:flex;align-items:center;justify-content:center;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dwg-iconCell:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwg-iconCellOn{background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l3)}
.dwg-colorRow{display:flex;flex-wrap:wrap;gap:8px;padding:2px 0}
.dwg-swatch{width:22px;height:22px;box-sizing:border-box;border:0;border-radius:50%;background:var(--dwg-accent);cursor:pointer;padding:0}
/* The selected swatch grows a ring rather than a tick: a tick on ten different
   accent hues needs its own contrast guarantee per hue. */
.dwg-swatchOn{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 4px var(--dsw-alias-state-business-primary)}
.dwg-dialogHint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dwg-choice{display:flex;flex-direction:column;gap:6px}
.dwg-choiceRow{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer}
.dwg-choiceRowOn{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dwg-choiceText{display:flex;flex-direction:column;gap:2px;min-width:0}
.dwg-choiceTitle{font-size:13px;line-height:18px}
.dwg-choiceHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dwg-dialogActions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dwg-btn{box-sizing:border-box;height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer}
.dwg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dwg-btn:disabled{opacity:.5;cursor:not-allowed}
/* Primary and danger buttons borrow the shipped button pair instead of
   inventing one: the button-primary fill is near-black on the light theme and
   near-white on the dark one, and label-primary-foreground is the label that
   clears contrast against it in the SAME theme, flipping with it. The danger
   variant only rebinds that fill, exactly like the shipped danger button.
   NB: no backticks anywhere in this stylesheet — it is a template literal. */
.dwg-btnPrimary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
/* Hover must step the FILL, not repaint it. The generic rule above replaces a
   solid fill with the row-hover tint, which on a filled button reads as "the
   fill disappeared and only the border is left" — the exact defect the previous
   screenshot showed. button-primary-hover is the fill's own neighbour step in
   each theme, so the pair stays a pair. */
.dwg-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.dwg-btnDanger{--dsw-alias-button-primary-fill:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
/* The error pair has no distinct hover step in the dark theme (primary and
   secondary are both red-400 there), so the step is mixed toward the on-colour
   label, which is white in both themes — one rule, a lighter red in both. */
.dwg-btnDanger:hover:not(:disabled){--dsw-alias-button-primary-hover:color-mix(in srgb,var(--dsw-alias-state-error-primary) 86%,var(--dsw-alias-label-on-color));background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.dwg-root:focus-visible,.dwg-row:focus-visible,.dwg-iconBtn:focus-visible,.dwg-moreBtn:focus-visible,.dwg-btn:focus-visible,.dwg-viewBtn:focus-visible,.dwg-iconCell:focus-visible,.dwg-swatch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
${COLORS.map(color => `.dwg-accent-${color}{--dwg-accent:${PALETTE[color][0]}}`).join('\n')}
${COLORS.map(color => `body[data-ds-dark-theme] .dwg-accent-${color}{--dwg-accent:${PALETTE[color][1]}}`).join('\n')}
@media (prefers-reduced-motion:reduce){.dwg-chevron{transition:none}}
`

    // ═══════════════════════════════════════════════════════════════════
    // Plugin body
    // ═══════════════════════════════════════════════════════════════════

    /** Mount the sheet once and remove it with the bundle. */
    const insertStyles = (id) => {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', id)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    return {
      /** Cordis services this browser half needs; `slots` is mandatory here. */
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'workspace-groups: dictionaries')
        ctx.effect(() => insertStyles('dsh-workspace-groups'), 'workspace-groups: styles')

        const log = {
          debug: (...values) => { if (typeof console !== 'undefined') console.debug('[workspace-groups]', ...values) },
          warn: (...values) => { if (typeof console !== 'undefined') console.warn('[workspace-groups]', ...values) },
        }

        // One document store for the whole page: the header, the tree and the
        // dialog all read the same authoritative snapshot.
        const data = createGroupsStore(log)

        // A transient notice bar for rejected mutations. It is a snapshot in its
        // own right so the region re-renders when it appears and clears.
        const notice = createSnapshotStore(null)
        let noticeTimer = null
        const notify = (message) => {
          if (typeof message !== 'string' || message.length === 0) return
          notice.set(message)
          if (noticeTimer !== null) clearTimeout(noticeTimer)
          noticeTimer = setTimeout(() => { notice.set(null) }, 7000)
        }
        ctx.effect(() => () => {
          if (noticeTimer !== null) clearTimeout(noticeTimer)
          noticeTimer = null
        }, 'workspace-groups: notice timer')

        /**
         * Optional-service accessors, resolved per call.
         *
         * `ctx.get` is used rather than a hard `inject` list because the region
         * must still render when a domain service is absent (a headless shell);
         * a control whose service is missing reports that instead of disappearing.
         */
        const lookup = (name) => {
          try {
            return ctx.get(name)
          } catch (error) {
            log.warn(`optional service "${name}" is unavailable`, error)
            return undefined
          }
        }

        const injected = {
          data,
          notice: notice.source,
          notify,
          ws: () => lookup('workspaces'),
          ui: () => lookup('uiWorkspace'),
          menus: () => lookup('contextMenus'),
        }

        /**
         * The "全部折叠" command. It needs the `shortcuts` service, so it is
         * registered behind `ctx.inject` rather than at the top of `apply`: a
         * shell without shortcuts simply never grows the command, instead of
         * failing activation for the whole bundle.
         *
         * `primary+alt+U` is unclaimed by the shipped catalog and by the three
         * desktop platforms; it also carries the second modifier the Web runtime
         * demands, so one binding serves both runtimes. `modals: ['sidebar']`
         * keeps it live while the Web drawer is open — collapsing the tree from
         * inside that drawer is exactly when it is wanted.
         */
        const t = ctx.locale.bind(NS)
        ctx.inject(['shortcuts'], (sctx) => {
          sctx.effect(() => sctx.shortcuts.register({
            id: 'workspaceGroups.collapseAll',
            label: () => t('shortcut.collapseAll'),
            aliases: ['collapse all workspace groups', '全部折叠'],
            defaults: {
              'desktop:macos': { code: 'KeyU', modifiers: ['primary', 'alt'] },
              'desktop:windows': { code: 'KeyU', modifiers: ['primary', 'alt'] },
              'desktop:linux': { code: 'KeyU', modifiers: ['primary', 'alt'] },
              'web:macos': { code: 'KeyU', modifiers: ['primary', 'alt'] },
              'web:windows': { code: 'KeyU', modifiers: ['primary', 'alt'] },
            },
            regions: ['page'],
            modals: ['sidebar'],
            resolve: () => ({
              status: 'handled',
              run: () => { void data.mutate('collapseAll', {}) },
            }),
          }), 'workspace-groups: collapse-all shortcut')
        })

        /**
         * The inject face is a PROPS FACTORY, not a prop: the renderer spreads
         * its own keys into the entry (`<Comp {...kit} {...injected} ...>`), one
         * prop per key — the same flat shape the shipped browser publishes
         * (`startSession`, `open`, `createWorkspace`, …).
         *
         * So the face publishes exactly one prop, `injected`, holding this
         * bundle's handles. Returning the handles themselves (`inject: () =>
         * injected`) spreads `data`/`notice`/… as top-level props instead, and
         * the region then reads `props.injected === undefined` and dies in its
         * first hook. Because a shadowing entry (`priority: -1`) answers a
         * render crash by ABDICATING to the next occupant, that mistake shows up
         * as "the plugin silently does nothing", not as a visible error.
         */
        ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
          name: 'sidebar.workspaces',
          priority: -1,
          locale: NS,
          inject: () => ({ injected }),
        }, WorkspaceGroups))
      },
    }
  },
})
