# 实现细节与取舍

本文说明这个插件**为什么**这样写。设计与验收清单在 [PLAN.md](PLAN.md)；面向使用者的说明在 [README.md](../README.md)。

## 1. 它是怎么插进侧栏的

左侧栏的每个区块都是 Web Client 的一个 slot。浏览工作区的那个区块叫 `sidebar.workspaces`：

```ts
// packages/client/ui-sidebar/src/client/index.ts:101
'sidebar.workspaces': { kind: 'single', scope: 'root', inject: SIDEBAR_SECTION_INJECT }
```

`single` 意味着一个单元格、一个赢家。DSH 自带的 `WorkspaceBrowser` 注册在默认 `priority`（0），所以本插件注册为 `priority: -1` 就替换了它。这是 slots 文档里写明的正规做法：

> `priority` is a shadowing rank for `single` … Lower values run or render first. Ordinary additive contributions should choose a fresh list or hoc `id` …; **intentionally reusing a shipped cell replaces its presentation.**

（`docs/subsystems/slots.md`）而且这一步是安全的：schema 校验对 `single` 只禁止**同优先级**的第二个注册，正是为了让「故意替换」可行。

### 为什么不用「子槽」方式叠加

`sidebar.workspaces` 是 `single`，内部那个扁平列表不是 slot，没有可以插进去的位置。DSH 不提供「在每个项目前面加一层分组」的扩展点，所以要么替换整个区块，要么做不到。选择了替换。

### 替换的代价，以及补回来的东西

被替换的 entry 声明了这些子槽，它们跟着一起消失：

| 丢掉的子槽 | 原来的作用 | 本插件的替代 |
| --- | --- | --- |
| `sidebar.workspaces.directoryFlow` | 选目录/输入路径的流程 | `uiWorkspace.pickDirectory()` + 自建新建项目按钮 |
| `sidebar.workspaces.session.row.action` | 对话行的归档/置顶按钮 | 对话行不再显示这两个按钮；右键原生菜单里有 |
| `sidebar.session.row.leading` / `.trailing` / `.hover` | 对话行两侧/悬停扩展位 | 行内自绘状态点、置顶记号、更新时间 |
| `sidebar.workspaces.session.menu.item` | 旧版对话菜单扩展位 | 不提供（原生对话菜单仍然工作） |
| 它自己的搜索框、工作区改名/删除对话框 | 搜索与两个弹窗 | 自建搜索框；改名/删除改成插件自己的对话框 |

**没丢的**：DSH 内置的对话右键菜单（`target: 'session'`）、两个对话浮层、`target: 'workspace'` 的菜单行。这些属于 ui-workspace 自己的激活，不属于那个 entry，所以继续工作。本插件的对话行右键就是打开它们：

```js
menus.open({ kind: 'session', value: { sessionId: node.id, displayTitle: node.title } }, point)
```

### `inject` 是「出 props 的工厂」，不是「一个 prop」

这是本项目踩得最深的一次坑，值得写下来。

渲染器组合一个 entry 的写法是（`scoped-slots.tsx` 的 `renderEntry`）：

```jsx
<Comp {...kit} {...injected} {...slotInjected.props} {...ownerProps}>{children}</Comp>
```

`injected` 是 `entry.inject()` 的**返回值**，它会被摊平成一个个 prop —— **每个键 = 一个 prop**。这是给「发布动作」用的形状：自带 `WorkspaceBrowser` 发布的是 `startSession`、`open`、`createWorkspace` … 一堆平铺的函数。

第一版本插件写的是：

```js
inject: () => injected,            // ✗ 摊平 data / notice / notify / ws / ui / menus
```

于是组件收到的 props 里**没有** `injected`，只有 `data`、`notice`…，而组件第一件事就是读 `props.injected.data.source` → `undefined` 上的属性访问 → 抛。正确写法是只发布一个键：

```js
inject: () => ({ injected }),      // ✓ 平铺成一个名为 injected 的 prop
```

为什么这个错误表现得像「插件根本没装上」：`single` 槽的 entry 一旦渲染抛错，`SlotErrorBoundary` 会 `reportEntryError(..., { abdicate: true })`，**该 entry 被退役**，单元格回落到下一个幸存者——自带的浏览器。于是页面看起来完全正常（就是原生侧栏），没有任何报错提示，重启也一样，因为这是每次挂载都会重演的确定性错误。`Slots` inspect 里能看到的唯一线索是 occupants 中 `priority: -1` 的那条 `active: false`。

因此组件现在带一道**在第一个 hook 之前**的接线检查：`injected` 缺失、`useSectionScroller` 缺失、`t` 缺失时直接返回一个可见的错误面（`.dwg-miswired`），而不是抛给会把 entry 静默退役的边界。`test/smoke.mjs` 里钉住了两种坏形状（平铺 face、缺 slot hook）都必须落到这道检查上，而真实组合永远不落到那里。

## 2. 数据归谁

这是整个插件最重要的一条线：

- **DSH 拥有「存在什么」**：工作区、对话、标题、归档集合、置顶集合。插件通过槽的标准 props 读（`useWorkspaces` / `useSessions` / `useSessionStatus`），通过公共客户端服务写（`uiWorkspace` / `workspaces` / `contextMenus`）。
- **插件只拥有「树」**：哪个项目在哪个组、组名/色/图标/置顶、每组内顺序、折叠状态、视图模式、已归档组。

因此分组文档只引用 `workspaceId`，从不复制工作区真值。宿主半边的 `prune` 动作会丢掉已经不存在的工作区 id——引用一个不存在的 id 只是「渲染为空」，不会崩。

这条线也决定了卸载行为：卸掉插件，DSH 的工作区和对话原样存在，只是不再分组。

## 3. 状态怎么存

`<DSH_HOME>/workspace-groups/state.json`，一个 JSON 文档：

```json
{
  "version": 1,
  "groups": [{ "id": "g1", "name": "客户端项目", "color": "blue", "icon": "code",
               "pinned": true, "collapsed": false, "order": 0, "createdAt": 1 }],
  "archivedGroups": [ /* 同上，只是不在树里 */ ],
  "assign": { "<workspaceId>": "<groupId>" },
  "orders": { "<groupId>": ["<workspaceId>", "..."], "__ungrouped__": ["..."] },
  "workspaceState": { "<workspaceId>": { "expanded": true, "showAll": false } },
  "ui": { "view": "grouped" }
}
```

几条设计决定：

- **不用 workflow/数据库**：树很小，一个文件就够；一次读全量，写全量。
- **原子写**：先写 `<file>.tmp` 再 `renameSync`。崩在写盘中间不会留下半个文件。
- **串行写**（浏览器侧 `chain = result.then(noop, noop)`）：拖动落点如果赶上一次改名还在飞，两次写不会乱序 resolve。
- **不做乐观更新**：每次变更的响应就是**完整的新文档**，直接渲染它。响应是渲染更新，也是失败报告——不需要第二套「回滚」逻辑。
- **坏文件自愈**：`normalize()` 把任何形状都规整回合法文档（未知字段丢弃、越界数值夹紧、超长名字截断），绝不让侧栏因为一个坏 JSON 而白屏。

## 4. 两条路由

宿主半边在 `ctx.inject(['connection'])` 里注册两条路由：

```
GET  /api/workspace-groups/state    → 完整文档
POST /api/workspace-groups/mutate   → { action, payload } → 完整文档
```

- 注册在 Connection 的认证栅栏内：只有这个宿主的页面能读写。
- 请求体上限 64 KiB（`requestBody: 'buffered'`），JSON 解析失败回 400。
- 响应带 `cache-control: no-store`。
- 没有 `fetch.register` 面（无头组合）时静默跳过——插件仍加载，只是没有路由，浏览器侧会看到读取失败并在提示条里说明。

**为什么不用 `storage-domain`/zod**：这是个 link 安装的 bundle，多一个 peer 依赖就多一个解析失败的可能。直接用 `node:fs` 的四个函数足够，也更容易解释。

## 5. 浏览器半边的结构

一个经典脚本，`window.__ModuleLoader__.load({ id, factory })`，只 `require('react')`（外加可选的 `react-dom`，拿不到就走 portal 的退路）。

```
常量与调色板 → 双语字典 → 工具 → 文档 store → 树派生 → 原子组件
  → 本地菜单 → 对话框 → 区域组件 → 样式表 → apply
```

几条值得注意的实现：

### 树是纯函数派生的

`deriveModel(workspaces, sessions, statuses, pins, archives, document)` 只吃参数，所以树、搜索索引、键盘行走、最近视图共享**同一份**「屏幕上是什么」的定义。没有第二套状态。

### 顺序按「协调」而不是「重排」

每个分组保存一串 workspaceId。渲染时把存储顺序与当前成员对照：还在的就保留相对位置，其余按调用方顺序追加。于是「拖进来的项目」在无关项目增删时保持位置，而「已经被删掉的 id」自然消失。

```js
reconcileOrder(members, stored)  // stored ∩ live，按 stored 相对顺序；再补 live 的其余项
```

### 折叠状态是文档的一部分

分组和项目的折叠状态都写在文档里（分组用 `group.collapsed`，项目用 `workspaceState[id].expanded`），所以重启后保持。`collapseAll` 同时折叠所有分组并把每个项目收起。

组头的点击由 `handlers.toggle` 驱动，但**这个 handler 曾经不存在**：`GroupSection` 里写着 `onClick: handlers.toggle`，而组头拿到的 handler 包（`dropHandlers`）只装了拖拽五个 + `menu`，于是 `handlers.toggle` 是 `undefined`——点击抛 `TypeError`，被 React 的事件边界吞掉，表现为「组头点了没反应、只能展开不能收起」，而且**任何地方都不会报错**。修法是把 `toggle` 真的接进那个包（`dropHandlers(handlers, fold)`），并且让「未分组」这个没有折叠态的行继续 `fold === undefined`、不接 `toggle`。另外组菜单里补了一行「收起分组 / 展开分组」，理由见 §5「菜单」。

`toggleGroup` 提交的是**目标状态**（`collapsed: !group.collapsed`）而不是一个 `toggle` 动词，这样连点两下不会因为并发乱序折到错误的一边。

### 折叠/展开的可见性

两处可见性问题，都是「不报错所以难找」那一类：

1. `.dwg-searchInput` 自己 `outline:0` 关掉了刚给的焦点环，可是没有别的焦点反馈，于是聚焦时输入框里出现一个硬边方框（就是用户截图里那个黑框）。修法：焦点反馈留给外面那个圆角容器（`.dwg-search:focus-within`），输入框自己在 `:focus`/`:focus-visible` 都 `outline:0`。
2. 焦点环和强调色原来用的是 `--dsw-alias-brand-primary`，这个 token 是**单色品牌墨色**（浅色主题近黑、深色主题近白），不是蓝色强调色。浅色主题下它画出来就是黑框。交互蓝是 `--dsw-alias-state-business-primary`；焦点环应该读平台自己的 `--dsw-focus-ring-width` + `--dsw-focus-ring-color`。这条现在有测试钉住（`CSS never uses the monochrome brand ink as an accent`）。

### 拖动

五个事件处理器：`beginDrag` / `endDrag` / `dragOver` / `dragLeave` / `drop`，状态用一个 `dragRef`（载荷）+ 一个 `dragOver`（当前高亮行）表示。

拖放矩阵：

| 拖的东西 | 落在 | 结果 |
| --- | --- | --- |
| 项目 | 组头 / 组内空白 | 加入该组（追加到组尾） |
| 项目 | 「未分组」区域 | 移出分组 |
| 分组 | 另一个组头 | 按落点重排（同区段内） |

`dragLeave` 用 `relatedTarget` 判断是否真的离开（否则子元素间的移动会闪）。

**排序只有拖拽这一条路径。** 组之间、项目在同组内的顺序都由落点决定：`drop` 会先算出目标区段的完整顺序，再连同 `beforeGroupId` 一起发给 `orderGroup` / `orderWorkspace`。曾经还有一个右键菜单「调整顺序 →」的子菜单做同样的事，已经拆掉了：树上已经教过的动作，多一条列表就等于多一份要维护、会走样的实现。项目跨组仍是「移动到组 →」（拖拽的等价路径），因为它同时改变归属，不只是顺序。

### 菜单

组头和项目行的菜单是**区域自己渲染的** `PopupMenu` 组件（`position: fixed` + `ReactDOM.createPortal`），因为这样「移动到组 →」才能是真子菜单，而不必去碰别的插件的私有菜单内部。

组菜单现在只剩**一个**子菜单入口都没有的平铺列表：折叠、新建项目、编辑分组、置顶、归档、删除。「颜色 →」「图标 →」两个子菜单已经并进「编辑分组…」对话框（见 §5「外观一处改」），因为三件事都在描述同一个对象的外观，拆成三个菜单项会让用户在三个地方各改一次，而且没有任何一个界面能同时看到当前的组合。

对话行相反：右键直接打开 DSH 的共享菜单，所以置顶/改名/Fork/归档/复制 id 全是原生实现。

`PopupMenu` 的键盘支持刻意做得小：`Escape` 关闭、`↑`/`↓` 移动焦点、`Enter` 激活；点外面关闭。子菜单用 `onMouseEnter`/`onFocus` 打开（目前只有项目菜单的「移动到组 →」还在用）。

**定位是量出来的，不是猜的。** 每个菜单都从「打开它的那个控件」拿一个点（`pointOf(button)` = 控件左下角 + 2px），第一遍以 `opacity: 0` + `pointer-events: none` 画在锚点处（不能用 `visibility: hidden`——隐藏元素拿不到焦点，而下一个 effect 正要把焦点移进菜单），`useLayoutEffect` 量到真实尺寸后再夹进视口（`left ≤ innerWidth - width - 8`、`top ≤ innerHeight - height - 8`）。先量后画的意义在于：菜单高度取决于条目数，靠猜的高度一定会让菜单要么越界要么跳一下。

这一条也曾经错过一次：`RowActions` 的「⋯」按钮调用的是 `onMenu()`，**没带事件**，所以 `menu.anchor` 是 `undefined`，兜底分支把所有菜单画在视口左上角（用户的第一个反馈就是这张截图）。修法是把事件从 `IconButton` 一路传到 `RowActions`、再到 `pointOf`。`test/mount.mjs` 现在用一个 stub 的 `getBoundingClientRect` 钉住「菜单真的开在按钮上」和「靠近底边时被夹住而不是被裁掉」。

组菜单第一项是「收起分组 / 展开分组」：组头点击虽然能折叠，但拖拽时误触也会折叠，而且键盘用户找不到入口。

### 置顶：位置不变也算「没反应」

「固定到顶部」曾经在屏幕上看起来完全没作用。树的推导是对的、请求也真的发出去了，问题在别处：置顶把组挪进 pinned 区段的最前面，而 pinned 区段和其余区段之间**没有任何分隔**，所以「从第 1 行挪到第 1 行」在视觉上是零变化，用户只能看到菜单关掉。

修法是把两个区段画成两个区段：pinned 与其余内容之间加一条 `.dwg-pinnedRule` 细线。取消固定则是「落到其余区段的第一行」，所以取消之后组仍然在最上面——这条也在测试里写明，免得下次有人以为它坏了。

`test/mount.mjs` 断言的是**行真的换了位置**，而不只是断言发了请求：一个发了对的动作但行没动的按钮，和死按钮在用户眼里是同一件事。

### 排序交给拖拽，不再重复实现

曾经还有右键菜单「调整顺序 →」的子菜单，用来把组放到指定组的相邻位置。它和拖拽做的是同一件事，而且它的 payload（完整顺序 + `beforeGroupId`）比拖拽更容易写错——有一版在发送前把目的地也从 `order` 里剔掉了，Host 找不到下标就只会追加，于是「移到 X 上面」悄悄变成了「移到末尾」。这个子菜单已经拆掉，`orderGroup` / `orderWorkspace` 的调用点只剩拖拽一处。`test/host.mjs` 保留三种插入情形（空目的地追加 / 已列出目的地插入 / 未列出目的地退化为追加）的断言，因为那正是拖拽也会走的那条规则。

### 外观一处改：编辑分组对话框

名字、图标、颜色是同一个对象（一个分组的「外观」）的三个属性，所以它们在**一个**对话框里：

```
┌ 编辑分组 ─────────────────────────┐
│ 名称  [ 学习                    ] │
│ 图标  ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ (10/行)│
│ 颜色  ● ● ● ● ● ● ● ● ● ●        │
│                    [取消] [保存]  │
└──────────────────────────────────┘
```

新建分组用同一个表单（标题不同），所以「新建时就能选好外观」不需要第二个界面。保存时**一次** `updateGroup` 带上 `name` + `color` + `icon`：三个字段一起到达，Host 的 `updateGroup` 本来就是一次写盘的。

布局借鉴了 NarraFork 的 `RecentTabFolderEditModal`（MPL-2.0）——一个图标网格 + 一排色块，选中项用背景而不是勾号标记。只借了这个**形态**：没有引入 Mantine，图标来自 Tabler（MIT，见仓库根的 NOTICE.md），它的 20 个图标和 10 个色板是自己的取值。

两条与无障碍相关的小决定：

- 图标单元和色块都是真 `<button>`，带 `aria-pressed` 和 `aria-label`（色块的标签是「蓝色」「红色」这类词，不是一个十六进制值）。
- 选中色块用**外圈 ring**（`box-shadow` 两层）而不是打勾：在 10 个不同色相上各打一个勾，每个色相都要单独证明勾的对比度；一圈中性色的环只需要证明一次。

色板仍然是**预设**，不做自由取色器：10 个颜色各自有浅/深两档并在两档下都过 4.0:1，这是自由取色给不了的保证。

### 删除对话框的默认值

```
（●）解散组（项目回到未分组）        ← 默认
（ ）连同项目一起注销
```

安全项永远预选。想删项目得**再点一次**那个危险选项。这是防误删的主要手段。

### 搜索

一个输入框搜三种名字。去抖 170ms（`SEARCH_DEBOUNCE_MS`），命中上限来自配置（`searchLimit`），超出时提示缩小范围。每条命中都带所属组/项目路径；点中后先展开对应节点（`updateGroup` / `setWorkspaceState`），再把它滚进视野。

表头的放大镜是**一个按钮管开和关**：再按一次收起搜索框并清空查询词。第一版只写了「打开」分支，于是按钮第二次点击什么也不做——控件无法撤销自己的动作，用户只能按 Escape 或刷新页面。这类缺陷在测试里也容易漏，因为渲染一直是对的；`test/mount.mjs` 现在按两次并断言输入框消失、`aria-label` 在「搜索 / 收起搜索」之间来回切换。

### 状态徽标

优先级：待处理（审批 / 计划审阅 / 提问）> 运行中 > 新完成。组头汇总它所有项目会话的计数，所以不展开也知道有事。

### 键盘行走

`↑`/`↓` 在 `.dwg-row[tabindex]` 里循环；`→`/`←` 对可折叠行执行「折叠/展开」（通过 `target.click()` 复用同一路径，而不是第二套折叠逻辑）。

### 样式

一张注入的 `<style>`，**每个选择器都带 `dwg-` 类**，所以不可能污染别人的界面。所有界面色走 `--dsw-alias-*` token（token 改名只会让外观退化，不会让渲染崩掉）；唯一的字面色是 10 个强调色，每个都有浅/深两半：

```css
.dwg-accent-blue{--dwg-accent:#4176E6}
body[data-ds-dark-theme] .dwg-accent-blue{--dwg-accent:#7AAAFF}
```

`body[data-ds-dark-theme]` 是主题呈现器真正设置的属性（`theme-presenter.ts`），不是猜测。

几何对齐侧栏自身：32px 行高、8px 行内边距、12px 圆角、14/20px 标题、10/16px 元信息。树的滚动容器同时喂给侧栏的滚轮交接（`bindScrollerRef`），这样触控板和滚轮在两个滚动区之间过渡正常。

token 分两类，别混用：`--dsw-alias-state-business-primary` 是**交互蓝**（强调色、焦点、运行中状态点），`--dsw-alias-brand-primary` 是**单色品牌墨色**（浅色主题近黑、深色主题近白）。把后者当强调色用，浅色主题下就是一堆黑框。主按钮不自己配色，而是借原生那对 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（两者会随主题一起翻转），危险变体只覆写 fill（和原生的 `dangerButton` 一样）。

### rail（折叠态）

侧栏折叠后只有 49px 宽，树放不下。所以 `wide === false` 时区域只渲染三个 36×36 控件（搜索 / 新建项目 / 新建分组），每个都**先展开侧栏**再动作——对一个没人看得见的树做操作是死控件。

## 6. 验证到了哪一步

| 层面 | 手段 | 状态 |
| --- | --- | --- |
| 语法 | `node --check`（当 `.mjs`） | ✅ |
| Host 行为 | `test/host.mjs`：两条路由、12 个动作、持久化、坏文件自愈、请求校验、禁用行 | ✅ |
| 工厂形状 | `test/smoke.mjs`：`__ModuleLoader__.load` 拿到 id、只 require 平台种子、`inject`/`apply` 存在 | ✅ |
| 注册形状 | 一个 entry、`priority: -1`、不声明子槽、双语字典齐全（键集相同、95 条） | ✅ |
| **inject 形状** | `test/smoke.mjs`：`inject()` 只返回一个键 `injected`；平铺 props / 缺 slot hook 都落到组件自己的可见接线错误面 | ✅ |
| 快捷键 | 命令 id/标签/5 个 profile/Web 双修饰键/`modals: ['sidebar']` | ✅ |
| CSS | 10 色 × 2 主题、无未解析插值、只用文档里存在的 token、界面色无字面色 | ✅ |
| 包装后视图 | `test/render.mjs` | ✅ |
| 真实 React 渲染 | `test/render.mjs`：`react-dom/server` 渲染 wide/rail 两个变体，hook 合法、无 `undefined`/`NaN` 漏进标记 | ✅ |
| 真实挂载 | `test/mount.mjs`：jsdom + `react-dom/client`，effect 真跑、点击真发 POST、菜单与对话框真 portal 到 body、Escape 真关菜单、unmount 干净 | ✅ |
| **组头折叠** | `test/mount.mjs`：点组头真的 POST `updateGroup{collapsed:true}`、`aria-expanded` 翻成 `false`、子项目从 DOM 消失、再点一次回来；「未分组」行没有折叠态 | ✅ |
| **菜单定位** | `test/mount.mjs`：stub `getBoundingClientRect`，断言菜单开在按钮上（不是视口左上角）、靠近底边被夹进视口、Escape 仍能关 | ✅ |
| **token 语义** | `test/smoke.mjs`：样式表不出现 `--dsw-alias-brand-primary`（那是单色墨色不是强调色）、焦点环读平台 ring token、搜索框关掉自己的方块焦点环但仍由容器显示焦点 | ✅ |
| 失败路径 | `test/mount.mjs`：路由返回 503 时画失败面而不是永久转圈，点「重试」真的再发一次请求 | ✅ |
| **搜索开关** | `test/mount.mjs`：报表头放大镜两次——输入框出现/消失、`aria-label` 跟着翻转、带词关闭时查询词一起清掉 | ✅ |
| **置顶 / 排序** | `test/mount.mjs`：断言置顶后行真的移到 pinned 区首、pinned 分隔线在、菜单里没有重复的排序子菜单；`test/host.mjs` 覆盖 `orderGroup` 的三种插入规则（拖拽走的就是这条） | ✅ |
| **实际观感** | 真浏览器页面（本会话的 client inspect 桥超时，无已认证页面） | ❌ 需用户确认 |
| 真机交互 | 拖动（DnD 无法在 jsdom 里模拟数据载荷）、快捷键、重启后持久化 | ❌ 需用户确认 |

`render` 与 `mount` 用的是真实 React 18 / jsdom，不是手写替身。它们能证明「结构对、内容对、交互路径通、不抛异常」，不能证明「好看」。这一点在 README 和给用户的说明里都写清楚了，不冒充。

### 三处因测试而改的实现

测试不是走个过场——下面三条都是先跑红、再改代码、再跑绿的。（第 1 节那处 `inject` 形状问题不在其中：四个套件当时是绿的，因为测试自己也是按错形状喂的 props，直到真机上「静默无反应」才暴露出来——那才是这套测试真正的盲区。）

**1. 首屏把所有项目画进「未分组」。** `test/render.mjs` 第一次运行就抓到了：Host 文档还没到时，`deriveModel` 用空文档推导，于是**每一个项目**都被画进「未分组」，等应答回来再重新归位。视觉上像 bug 而不像加载。修法是文档里加 `loaded`：`emptyDocument()` 为 `false`，`normalizeDocument()` 一旦收到 Host 应答就置 `true`，树在 `loaded !== true` 时只画占位行。

**2. 路由不可达时永远转圈。** `test/mount.mjs` 补了一个「Host 返回 503」的场景，发现树会停在 `…` 上不动。修法是文档里再加 `readError`：读取失败时把它写进文档，树改画「失败原因 + 重试」；点重试重新发 GET。这条与 `document.error`（Host 自己报告的状态文件问题）是**两个不同的失败**，所以是两个字段。

**3. 失败场景的测试一开始读的是同一个 store。** 第一版把「503」测试挂在同一个 `apply()` 的 store 上，于是文档已经是 `loaded: true`，永远走不到失败分支——测试假通过。改成第二次 `apply()` 拿一套新 store，才真的覆盖到那条路径。测试自己也会骗人，这一点同样不隐瞒。
