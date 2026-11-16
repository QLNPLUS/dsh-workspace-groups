# dsh-workspace-groups

把 DSH 左侧栏里的工作区（项目）收进**可命名、可换色、可折叠的分组文件夹**，让项目再多也能一眼找到。

## 解决的问题

DSH 的侧栏把每一个工作区平铺成一列。项目一多，这一列就变成长条：找某个项目要滚半天，同类项目（同一客户、同一阶段、同一技术栈）彼此不相邻，最近改过的和早就搁置的混在一起。

这个插件把那一列变成三层树：

```
工作区
├─ 客户端项目            ← 分组（可改名 / 换色 / 换图标 / 折叠 / 置顶）
│  ├─ acme-site          ← 项目（工作区，可折叠）
│  │  ├─ 登录页重构       ← 对话
│  │  └─ 打包失败排查
│  └─ acme-admin
├─ 学习
│  └─ rust-notes
└─ 未分组                ← 拖到这里即移出分组（组内没有项目时不显示）
   └─ scratch
```

> 「未分组」只在它确实装东西时出现。项目全都归了组，这一段就不画——它曾是一条
> 带虚框占位的空标题，占着本该属于分组的位置。但**开始拖动项目时它会回来**，
> 因为那是把项目移出分组的唯一指针手势，落点必须在指针到达之前就存在。
> 一个项目和分组都没有的全新环境，树里给出的是一行提示而不是空面板。

## 功能

**分组**

- 新建分组；右键「编辑分组」在**同一个窗口**里改名字、选图标、选颜色（10 个预设色、20 个预设图标）。图标取 [Tabler Icons](https://github.com/tabler/tabler-icons)（MIT，见 [NOTICE.md](NOTICE.md)）。
- 拖项目到组头（或组内任意位置）即入组；拖到「未分组」区域即移出。
- 拖组头到另一个组头上，按落点重排分组顺序。
- 置顶分组固定在最上方（pinned 区段与其余分组之间有一条分隔线，置顶挪动后看得见位置变化）。
- 删除分组时给两个选项：**解散组（项目回到未分组，默认）** 或 **连同项目一起注销**。默认项永远是安全项，防止误删。
- 归档分组：从树里收走但不丢数据，随时在底部的「已归档分组」抽屉里恢复。

**折叠与持久化**

- 分组、项目都可折叠，状态写盘，重启后保持。
- 项目折叠时只显示最近 1–2 条对话（`previewSessions` 可配），展开后显示「查看全部 N 个」。
- 标题栏的折叠按钮一键全部折叠。

**搜索**

- 一个输入框同时搜**组名、项目名、对话标题**。
- 每条结果都写明所属组/项目，点一下就展开对应节点并滚动定位。
- 输入去抖 170ms，最多返回 `searchLimit` 条，超出提示缩小范围。

**两种视图**

- 分组视图（默认）：上面那棵树。
- 最近使用：所有对话拉平，按更新时间排序，带所属项目名。

**状态徽标**

组头与项目行会汇总子节点的实时状态：待处理（审批/计划/提问）> 运行中 > 新完成，带条目数。不展开也能看出哪个组有事。

**键盘**

- `↑` / `↓` 在树上逐行移动焦点。
- `→` / `←`（以及 `Enter`）折叠或展开当前行。
- 全局快捷键「全部折叠工作区分组」，可在设置里改。

**主题与无障碍**

- 10 个色板每个都有浅色/深色双值：深色模式下自动提亮一档（`body[data-ds-dark-theme]`），两种主题下对比度都 ≥ 4.0:1。
- 颜色只作用于组头的小图标和左侧 2px 细色条，不做大面积染色。
- 行有 `role="treeitem"` / `aria-expanded` / `aria-level`，拖拽有键盘替代（右键「移动到组」）。
- 遵循 `prefers-reduced-motion`。

## 安装

插件是标准的 DSH bundle 包，直接在插件页安装这个目录：

```bash
# 在 DSH 的 Plugins 页面
#   → Add plugin → Install from a local directory → 选这个包目录
```

或用工具安装：

```js
plugin_manager({ action: 'install_bundle', target: 'C:/path/to/workspace-groups' })
```

安装后**刷新页面**。左侧栏的工作区区域会被这棵树替换；插件行的 `enabled: false` 会退回 DSH 原生浏览器，分组数据原样保留在磁盘上。

## 配置

插件行的 `config:` 块（改动后刷新页面生效）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后侧栏回到 DSH 原生工作区列表，分组文档不动。 |
| `previewSessions` | `2` | 项目折叠时预览几条对话（1–6）。 |
| `persistDebounceMs` | `400` | 写盘前的静默时间，0–5000。 |
| `searchLimit` | `80` | 一次搜索最多返回多少条（20–400）。 |
| `seedGroups` | `[]` | 首次运行时预建的分组，形如 `[{ id, name, color, icon }]`。 |

数据文件：`<DSH_HOME>/workspace-groups/state.json`（默认 `~/.dsh/workspace-groups/state.json`）。原子写入（临时文件 + rename），坏文件会被规整回空文档而不是让侧栏崩掉。

## 装好之后的第一次运行

浏览器半边的包清单是在**页面加载时**解析的，所以装完（或改了 config）之后必须**刷新页面**，否则左栏还是 DSH 的原生列表。

刷新后侧栏区域先是一行 `…`（在读分组文档），然后才是树。三种结果都写清楚了，不会出现「转圈转到天荒地老」：

| 情况 | 侧栏显示 |
| --- | --- |
| 读到了 | 「组 → 项目 → 对话」树 |
| 还没读到 | 一行 `…` |
| 路由不可达（网络/鉴权失败） | 失败原因 + **重试** 按钮 |

失败原因来自 HTTP 状态本身（例如 `HTTP 503`），不猜；点「重试」会重新请求一次。

## 它不做什么

- **不改动 DSH 的工作区/对话真值**。插件只保存「哪个项目在哪个组」这类视图元数据，引用的是 `workspaceId`，从不复制目录、移动文件或改写对话。
- **不接管对话右键菜单**。对话行的右键走的是 DSH 原生菜单（置顶、重命名、Fork、归档、复制 id 都是原生实现），插件只在组头和项目行上提供自己的菜单。
- **不提供自由取色器**。预设色板保证深浅色主题下都协调；要自由取色请改 `client/client.js` 的 `PALETTE`。

卸载插件后，DSH 的工作区、对话、目录**原样存在**，只是不再分组。

## 开发

```
workspace-groups/
├─ plugin/index.mjs        Host 半边：分组文档的读写与两条 JSON 路由
├─ client/client.js       浏览器半边：侧栏树的实现（单个经典脚本）
├─ locale/{zh,en}.json    插件页的标题与说明
├─ cordis.patch.yml       bundle 层：插入 Loader 行
├─ docs/PLAN.md           完整设计与验收清单
├─ docs/DETAIL.md         实现细节与取舍
└─ test/                  四个离线测试（不随包发布）
```

四个测试按「越来越接近真实」排列：

| 文件 | 需要什么 | 证明什么 |
| --- | --- | --- |
| `test/host.mjs` | 无 | 两条路由、12 个动作、持久化、坏文件自愈、请求校验 |
| `test/smoke.mjs` | 无 | 工厂形状、注册形状（一个 entry、`priority: -1`、不声明子槽、**`inject()` 只出一个 `injected` prop**）、CSS（含 token 语义：不用单色墨色当强调色）、首屏树、接线错误面 |
| `test/render.mjs` | react + react-dom | 真实 React 渲染：hook 合法、props 合法、两个变体都出 HTML |
| `test/mount.mjs` | react + react-dom + jsdom | 真实挂载：effect 真的跑、点击真的发请求、**组头点击真的折叠/展开**、**菜单真的开在按钮上并被夹进视口**、菜单真的 portal 到 body、**图标/色板选择器里的选择真的写进请求**、**编辑保存时三个字段一起发** |

`render` / `mount` 需要 React 和 jsdom，因为它们要证明**真实渲染器**接受这棵树。它们不会因为缺依赖就报「测试失败」，而是打印 `SKIP` 并退出 0（「工具没装」不等于「插件坏了」）。启用方法：

```bash
# 在包目录里装一份（不会进包，files 里没有 node_modules）
cd workspace-groups && pnpm add -D react@18 react-dom@18 jsdom

# 或者指向任何一份已有的
WG_REACT_ROOT=/path/to/dir node test/render.mjs
```

### 看得到的那一层：`test/preview.mjs`

四个测试能证明结构对、交互通、不抛异常，**不能证明好看**。所以另有一个不是测试的工具：它把真实 bundle 挂进 jsdom，输出几个自带真实主题 token 和插件真实样式的独立 HTML：

```bash
node test/preview.mjs                 # → docs/preview-tree.html + preview-dialog.html + preview-buttons.html
node test/preview.mjs --dark          # 深色版本
node test/preview.mjs --all-groups    # 全部取消置顶（检查「分组 / 未分组」那条缝）
node test/preview.mjs --all-pinned    # 全部置顶（检查另一侧的缝）
node test/preview.mjs --filed         # 每个项目都归了组（「未分组」那一段必须消失）
node test/preview.mjs --blank         # 一个项目、一个分组都没有（空环境的提示行）
```

- `preview-tree.html`：整棵树的真实渲染
- `preview-dialog.html`：打开「编辑分组」对话框的样子
- `preview-buttons.html`：按钮默认态与 **hover 态**。静态页面没法真 hover，所以这个页面把插件样式表里**真实的** hover 声明原样抓出来、只改选择器套到 `[data-hover]` 上——看到的是真的声明，不是重画的颜色。

`docs/*.png` 就是对这些 HTML 用无头浏览器截图的结果。看一眼就知道间距、色块、选中环、按钮 hover 是不是想要的样子，而不必先装进宿主来回试。

两个「零依赖」的测试随时可跑，也是日常回归的主力：

```bash
node test/host.mjs && node test/smoke.mjs
```

**它们不能证明实际观感**——颜色、间距、拖动的手感需要真页面。这一点不冒充。

## 已知取舍

这个区域是 DSH 侧栏里 `sidebar.workspaces` 这个 `single` 槽的占用者。为了拿到「分组」这个结构，插件用更低的 `priority` 替换了 DSH 自带的 `WorkspaceBrowser`，因此原生浏览器声明的几个子槽不再渲染：`sidebar.workspaces.directoryFlow`、`sidebar.workspaces.session.row.action`、`sidebar.session.row.leading/trailing/hover`，以及它自带的搜索框与工作区改名/删除对话框。插件在这里重新实现了自己需要的那部分（原生目录选择 + 自己的搜索框 + 自己的对话框）。

DSH 内置的对话菜单（`target: 'session'`）、两个对话浮层、`target: 'workspace'` 的菜单行属于 ui-workspace 自身的激活而非那个 entry，所以继续工作——对话行右键就是原生菜单。

## License

MIT
