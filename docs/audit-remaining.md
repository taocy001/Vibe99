# Vibe99 综合技术审计报告（剩余未修复项）

> 原始审计日期：2026-05-04  
> 增量审计日期：2026-05-06  
> 范围：前端工程、性能与 UX、Rust 后端、安全  
> 说明：本报告已移除经代码审查确认已修复的审计项，仅保留当前代码基中仍存在的问题与建议。

---

## 一、前端工程

### 1.1 总体评价

项目采用了一种**务实的模块化策略**：以 `renderer.js` 为中央编排器（orchestrator），将面板生命周期、DOM 渲染管线、布局计算、设置系统、快捷键分发等拆分为独立 ES modules。核心布局引擎 `split-layout.js` 被设计为**纯函数、无 DOM 依赖**，并配有完整的 vitest 测试，是整个架构中最干净的部分。

### 1.2 模块职责与耦合

| 模块 | 职责 | 评价 |
|---|---|---|
| `renderer.js` | 编排器：终端创建、桥接 I/O、搜索栏、上下文菜单、菜单 action 分发、键盘 action 映射、会话恢复 | **过重**。1500+ 行，包含终端生命周期、`handleMenuAction` 巨型分发器、颜色选择器、命令面板封装等，违反了"单一职责"。 |
| `pane-manager.js` | 面板/标签生命周期、MRU、Tab 拖拽、面板拖拽、导航模式 | 相对聚焦，但 Tab 拖拽与面板拖拽两种机制放在同一模块，与 `layout-renderer` 存在回调耦合。 |
| `layout-renderer.js` | 全部 DOM 渲染：Tabs、Pane 定位、Divider、Status Bar | 职责合理，但依赖注入参数过多（~30 个），增加了调用方负担。 |
| `split-layout.js` | 二叉树布局计算 | **优秀**。纯函数、无副作用、可测试。 |
| `settings-ui.js` | 设置面板 DOM、Shell Profile 管理、持久化序列化 | 过重。包含字体检测、Shell Profile 增删改查拖拽、设置序列化、主题应用等。 |
| `input/*` | 键盘分发器、keymap 表、action 表 | **优秀**。声明式 keymap + 纯 action dispatcher 的设计非常干净。 |
| `shortcuts-registry.js` | 快捷键覆盖层，兼容旧版 API | 作为适配层合理，但 `JSON.stringify` 比较数组是性能隐患。 |

### 1.3 循环依赖与前置引用

- **【中等】renderer.js 存在显式的前置引用（forward refs）**：
  ```js
  let paneManager; let settingsUI; let layoutRenderer;
  ```
  `createPane` 在模块初始化阶段就被定义，但它内部通过闭包引用 `paneManager` 和 `layoutRenderer`，这两个对象在 `createPane` 之后才创建。代码注释承认这是为循环接线（circular wiring）而设。虽然 JS 闭包按引用捕获使其能工作，但这是一种**隐式依赖顺序约束**，任何 future refactoring 如果调整了初始化顺序就会直接崩溃。

- **【低】layout-renderer.js 对 context-menu.js 做动态 `import()`**：
  这是为了避免循环依赖的合理手段，但将同步的上下文菜单展示变为异步，若在菜单打开前模块未加载完成，会导致第一次双击 divider 的 preset 菜单延迟出现。

### 1.4 依赖注入与共享状态

- `st`（shared mutable state）被以对象引用方式传给 `pane-manager.js` 和 `layout-renderer.js`。这种设计**放弃了数据流向的单向性**，任何模块都可以随时修改 `st` 的任何字段。虽然代码中大量使用了 `st.panes = st.panes.map(...)` 来保持数组不可变，但 `st` 上的标量字段（`focusedPaneId`, `dragState`, `currentMode` 等）都是被直接赋值的。
- `settings` 对象作为**全局可变单例**从 `settings-ui.js` 导出，被 `renderer.js`、`layout-renderer.js`、`pane-manager.js` 直接读取和写入。没有 setter/拦截器，没有变更通知机制。

---

### 2. 状态管理

#### 2.1 `st` 共享可变对象的设计缺陷

**【严重】`st` 是事实上的全局可变状态桶**，包含以下字段：

```js
panes, focusedPaneId, nextPaneNumber, nextPanelSeq, renamingPaneId,
isRenderingTabs, dragState, currentMode, enterNavSourcePaneId,
sessionRestoreComplete, paneMruOrder, paneCycleState,
pendingClosePaneId
```

**问题：**
1. **无类型约束**：纯 JS 环境下，`st.panes` 中 pane 对象的结构没有运行时校验。`restoreSession` 中有手动校验 accent 的正则，但其他字段（如 `layout` 树结构）没有 Schema 验证。
2. **竞态条件**：`st.isRenderingTabs` 是一个手动实现的**重入锁**（reentrant lock），用于防止 `renderTabs` 在 drag 过程中被递归调用。但如果未来异步代码路径增多，这种 flag 机制不可靠。
3. **`paneCycleState` 缺乏原子性**：`cycleToRecentPane` 修改 `st.paneCycleState.index` 和 `st.focusedPaneId`，`commitPaneCycle` 再将其置空。如果在 cycle 过程中触发了 `focusPane`（例如用户鼠标点击了 tab），`paneCycleState` 会残留，直到下一次 cycle。

#### 2.2 `settings` 全局可变对象

**【中等】** `settings` 被多处直接修改（如 `settings.fontSize = ...`），同时 `applySettings()` 会将其同步回 DOM。这种"双向绑定"是手动维护的，任何遗漏都会导致 UI 与内存状态不一致。例如：
- `handleMenuAction` 中直接修改 `settings.fontSize`，然后手动调用 `applySettings()` 和 `layoutRenderer.render(true)`。
- `settings-ui.js` 的 keydown 监听也做同样的逻辑。
这是**重复的实现路径**，容易漏掉某个入口。

#### 2.3 面板数据的分离与不一致风险

**【中等】** 面板相关数据分散在四个数据结构中：
- `st.panes`：标签级元数据（title, accent, cwd, layout, focusedPanelId）
- `paneNodeMap`：DOM + Terminal 实例节点
- `panelDataMap`：分画面板的 cwd/shellProfileId/accent
- `activeCwdMap`：OSC 7 上报的当前工作目录

这四者之间**没有事务性保证**。例如 `destroyPanelNode` 会清理 `paneNodeMap`、`panelDataMap`、`activeCwdMap`，但如果 `onDestroyPanel` 抛异常，可能导致 Map 处于半清理状态。`splitPanel` 先修改 `panelDataMap`，再修改 `st.panes`，再调用 `onRender`——如果中间出错，数据已不一致。

---

### 3. DOM 性能

#### 3.1 渲染频率与批量更新

**【中等】** `renderTabs()` 在以下场景被调用：
- Tab drag 的每一次 `pointermove`（通过 `handleTabPointerMove`）
- `focusPane`、`splitPanel`、`closePane` 等操作
- 全量 `render()` 时

虽然签名缓存（`_tabsLastSig`）避免了无变化时的 DOM 操作，但**一旦发生变化，它会用 `replaceChildren()` 完全重建整个 tab 列表**。每个 tab 都重新创建 DOM 节点和事件监听器。对于 20+ 个 tab 的场景，这是 O(n) 的节点创建开销。更优的做法是虚拟 diff 或至少复用现有节点。

#### 3.2 重排与重绘

**【中等】** `renderPanes()` 在每次渲染时对所有可见 pane 执行：
```js
node.root.style.left = `${x}px`;
node.root.style.top  = `${y}px`;
node.root.style.width  = `${w}px`;
node.root.style.height = `${h}px`;
```

对于非 split 的 pane，它使用 `transform: translateX()`（并设置了 `willChange: 'transform'`），这对 GPU 合成友好。但对于 split 的 pane，它直接修改 `left/top/width/height`，这会触发**布局重排（Layout）**。在 divider drag 过程中，`renderPanes(false)` 被高频调用，可能导致掉帧。

**建议**：所有 pane 的移动都统一使用 `transform`，或至少为 split pane 使用 `transform: translate(x, y)` + 固定宽高。

#### 3.3 事件委托的缺失

**【中等】** `renderTabs()` 为每个 tab 的 `tabMain`、`tabClose`、rename `input` 都单独添加事件监听器。每次重新渲染都会创建新的监听器对象（旧的随 DOM 节点被 GC）。虽然现代引擎 GC 效率高，但这是一个不必要的开销。Tab 列表应使用**事件委托**：在 `tabsListEl` 上统一监听 `pointerdown`、`click`、`dblclick`。

同理，`ensurePaneNodes` 中为每个 panel header 的 close 按钮单独绑定监听器。

#### 3.4 滚动性能

**【低】** xterm.js 的 wheel 事件被拦截并重写：
```js
terminalHost.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  ev.stopImmediatePropagation();
  // ...
}, { capture: true, passive: false, signal });
```

`passive: false` 是必需的（因为要 preventDefault），这意味着浏览器无法异步处理滚动。在 120Hz ProMotion 屏幕上，每次 wheel 事件都会触发一次 JS 执行。当前实现使用 `_scrollAccum` 做 fractional line accumulation，逻辑正确，但 `pixelsPerLine` 计算依赖 `terminal.options.fontSize * terminal.options.lineHeight`，每次事件都读取 options 对象属性，可考虑缓存。

#### 3.5 Split Divider 的 DOM 操作

**【中等】** `renderSplitDividers()` 在每次 `renderPanes()` 时：
1. 隐藏所有现有 divider：`for (const el of splitDividerElMap.values()) el.style.display = 'none'`
2. 遍历 layout 树收集 dividers
3. 为每个 divider 查找或创建 DOM 节点
4. 移除不再使用的 divider：`el.remove(); splitDividerElMap.delete(splitNode)`

相比于 tab dividers（`dividerEls` 池化，共 10 个），split dividers 是**动态创建/销毁**的。频繁的 split/unsplit 会导致大量的 DOM 创建和销毁。建议同样使用对象池。

---

### 4. 内存管理

#### 4.1 事件监听器泄漏

**【严重】以下全局事件监听器在应用生命周期内持续活跃，且部分永远不会被移除：**

1. **`renderer.js:1315`**
   ```js
   window.addEventListener('keydown', dispatchKeydown, true);
   ```
   从未 `removeEventListener`。虽然应用是单页面且直到关闭才销毁，但在 HMR 或未来单元测试环境中会导致泄漏。

2. **`settings-ui.js:902`**
   ```js
   window.addEventListener('pointerdown', (event) => { ... });
   ```
   用于点击 settings panel 外部关闭。始终监听，每次点击都执行 `settingsPanelEl.contains(event.target)` 检查。

3. **`renderer.js:1411`**
   ```js
   window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', ...);
   ```
   从未移除。

4. **`input/dispatcher.js:28-29`**
   ```js
   window.addEventListener('compositionstart', () => { _composing = true; }, true);
   window.addEventListener('compositionend',   () => { _composing = false; }, true);
   ```
   全局 capture 监听器，永不移除。

5. **`renderer.js:1470`**
   ```js
   tauriWin.onResized(() => scheduleFullscreenCheck());
   ```
   Tauri 事件监听器返回的 unlisten 函数被丢弃。

6. **`settings-ui.js:975`**
   ```js
   bridge.onOpenSettings(() => { settingsPanelEl.classList.remove('is-hidden'); });
   ```
   返回值（unlisten）被丢弃。

#### 4.2 Map / WeakMap 使用

**【良好】** `splitDividerDataMap` 使用 `WeakMap<Element, Data>`，当 divider DOM 节点被移除时，数据自动释放，无需手动清理。

**【隐患】** `paneNodeMap`、`panelDataMap`、`activeCwdMap`、`splitDividerElMap` 都是强引用的 `Map`。`destroyPanelNode` 中做了 `delete`，基本正确。但以下场景可能泄漏：
- `restoreSession` 中如果 `deserializeLayout` 抛异常，`panelDataMap` 中已 set 的数据不会被回滚。
- `ensurePaneNodes` 创建了新 pane 但如果在 `initializePaneTerminal` 之前模块重新加载（如 HMR），`paneNodeMap` 中的 node 会残留。

#### 4.3 Terminal 实例生命周期

**【中等】** `destroyPanelNode` 调用 `node.terminal.dispose()` 和 `node.root.remove()`，但：
- `node.abortCtrl.abort()` 会取消所有通过 `{ signal }` 注册的事件监听器。这是正确的。
- 但 xterm.js addon 的 dispose 没有显式调用（`fitAddon.dispose()`, `searchAddon.dispose()`, `webLinksAddon.dispose()` 等）。虽然 `terminal.dispose()` 应该会清理其加载的 addon，但需要确认 xterm.js 版本的行为。
- `node.searchAddon?.clearDecorations()` 只在搜索栏打开时调用，如果搜索栏关闭时销毁 panel，decorations 可能残留。

#### 4.4 定时器泄漏

**【中等】** 多处使用 `setTimeout` 但未在适当的清理时机 `clearTimeout`：
- `settings-ui.js`：`scheduleSettingsSave()` 的 150ms debounce。在 `beforeunload` 中调用了 `flushSettingsSave`，但如果页面意外崩溃，定时器中的闭包会持有 `settings` 和 `bridge` 的引用。
- `renderer.js`：`menuBarTimer`, `fsCheckTimer`（macOS 全屏检测）。在 `beforeunload` 中未清理。

---

### 5. 事件系统

#### 5.1 键盘分发器设计

**【优秀】** `input/dispatcher.js` 的设计是代码亮点：
- `getKeymap()` 每次 dispatch 时调用，使 overrides 即时生效。
- `parsedKeymap` 缓存基于引用比较（`km !== cachedKeymap`），只有在 `shortcuts-registry.js` 调用 `refreshActiveKeymap()` 时才重新解析。
- 过滤链清晰：mode → palette open → chord match → skipInInput。

**【中等】但存在以下边界问题：**

2. **Settings UI 的 keydown 旁路（bypass）**：
   `settings-ui.js:908-931` 直接在 `window` 上监听 `keydown`，处理 `Escape`（关闭 settings）、`Cmd+,`（toggle settings）、`Cmd+=/-/0`（字体大小）。这些**没有走 dispatcher**，导致：
   - 在 `<input>` 中按 `Escape` 会关闭整个 settings panel，而不是仅 blur input。
   - 字体大小快捷键在 settings UI 和 terminal 中实现了两遍（`handleMenuAction` 中也有）。

3. **Tab / BracketLeft 的物理键匹配**：
   `keymap.js:154-160` 对 `Tab` 和 `[`/`]` 使用 `event.code` 匹配，这是正确的（layout-agnostic）。但 `]` 的匹配代码是 `BracketRight`，而 chord 字符串中使用的是 `]`。这在 `parseChordAlt` 中作为普通 key token 处理，在 `matchesChordAlt` 中做特殊分支。这种 split 逻辑增加了维护成本。

#### 5.2 xterm.js 与宿主的事件边界

**【严重】IME / Composition 处理极为复杂，存在维护风险。**

`renderer.js:397-503` 包含大量 WKWebView IME workaround：
- `keydown` capture 中清理 textarea value
- `keypress` capture 中阻止 keyCode 229 传播
- `compositionstart/update/end` 跟踪状态
- `beforeinput` 捕获 composition text
- `input` 中三条分支（Path A/B/C）处理不同 IME 场景

这些代码**高度依赖 xterm.js 内部实现细节**（`_keyDownSeen`, `_handleAnyTextareaChanges`, `_inputEvent`）。xterm.js 升级时（即使是 minor 版本），这些假设可能失效。

#### 5.3 事件冲突

**【中等】Wheel 事件的拦截过于激进**：
```js
terminalHost.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  ev.stopImmediatePropagation();
  // ...
}, { capture: true, passive: false, signal });
```
`stopImmediatePropagation()` 会阻止 xterm.js 自身的 wheel 监听器执行。当前实现完全替代了 xterm 的滚动逻辑，这要求维护者必须持续跟进 xterm.js 的滚动行为变化（如 future touchpad gesture support）。

**【低】Broadcast 模式下的键盘输入**：
```js
terminal.onData((data) => {
  if (broadcastEnabled) {
    for (const pnode of paneNodeMap.values()) {
      if (pnode.sessionReady) bridge.writeTerminal({ paneId: pnode.paneId, data });
    }
  }
});
```
这里 `paneNodeMap.values()` 遍历的是当前快照。如果在遍历过程中其他 pane 被销毁（例如 terminal 进程退出触发 `onTerminalExit`），`pnode` 可能已被 dispose，但 `sessionReady` 仍为 true（因为 `destroyPanelNode` 在回调之后执行）。这不会导致崩溃（bridge 层会处理不存在的 paneId），但属于竞态。

---

### 6. 代码质量

#### 6.1 复杂度与文件大小

| 文件 | 行数 | 问题 |
|---|---|---|
| `renderer.js` | ~1500 | 过重。`createPane` 函数 450+ 行，`handleMenuAction` 150+ 行。 |
| `settings-ui.js` | ~1000 | `applyPersistedSettings` 含内联迁移逻辑，`renderModalShellProfiles` 近 200 行。 |
| `layout-renderer.js` | ~510 | 合理。 |
| `pane-manager.js` | ~680 | 合理，但拖拽逻辑较分散。 |
| `shortcuts-ui.js` | ~368 | 两个几乎相同的 render 函数（`renderIntoContainer` 和 `renderModalShortcuts`）。 |

#### 6.2 重复代码

**【中等】** `rafThrottle` 在 `pane-manager.js` 和 `layout-renderer.js` 中**完全重复**实现。

**【中等】** 字体大小调节逻辑在三处重复：
1. `settings-ui.js` 的 `window.addEventListener('keydown', ...)`
2. `renderer.js` 的 `handleMenuAction`（`font-size-increase` 等）
3. `renderer.js` 的 `keyboardActions` 创建（`fontSizeIncrease` 等）

**【低】** `getPanelIndicator` 在 `updateStatus` 中被调用了两次（lines 112 和 119），第二次的结果覆盖了第一次的使用场景。

**【低】** `shortcuts-ui.js` 中 `getShortcutActionName` 和 `getShortcutActionDescription` 是两个几乎平行的 huge object literals。应考虑合并为一个对象。

#### 6.3 魔法数字

| 位置 | 数字 | 含义 | 建议 |
|---|---|---|---|
| `renderer.js:100` | `10` | divider 池大小 | 应命名 `MAX_TAB_DIVIDERS` |
| `renderer.js:202` | `20`, `8` | terminal 最小 cols/rows | `MIN_TERMINAL_COLS`, `MIN_TERMINAL_ROWS` |
| `renderer.js:830` | `3000` | shell change grace period (ms) | `SHELL_CHANGE_GRACE_MS` |
| `pane-manager.js:352` | `6` | drag 启动阈值 (px) | `DRAG_START_THRESHOLD_PX` |
| `pane-manager.js:423` | `180` | tab focus pending timeout (ms) | `TAB_FOCUS_PENDING_MS` |
| `layout-renderer.js:421` | `400`, `2000` | pane width min/max | `MIN_PANE_WIDTH`, `MAX_PANE_WIDTH` |
| `layout-renderer.js:462` | `0.0005` | ratio 变化阈值 | `SPLIT_RATIO_EPSILON` |
| `settings-ui.js:380` | `150` | settings save debounce (ms) | `SETTINGS_SAVE_DEBOUNCE_MS` |
| `renderer.js:1399` | `120` | resize debounce (ms) | `RESIZE_DEBOUNCE_MS` |

#### 6.4 命名规范

- **【低】** 模块私有变量混用 `_` 前缀和不使用 `_` 前缀。例如 `layout-renderer.js` 中的 `_pendingRatioNode`、`_tabsLastSig` 使用下划线，但 `dividerDrag`、`splitDividerDrag` 不用。
- **【低】** `st` 作为变量名过于简短，不具备自解释性。`sharedState` 或 `appState` 更好。
- **【低】** `_ta` 作为函数名（返回 textarea）非常隐晦。

---

### 7. 可维护性

#### 7.1 测试覆盖

**【严重】仅有 `split-layout.test.js` 一组测试。**

这是项目中唯一的测试文件，覆盖了：
- `leaf()`, `split()` 构造函数
- `computeLayout()` 的各种场景
- `collectDividers()`
- `collectPanelIds()`
- `replaceLeaf()`, `removeLeaf()`
- `serializeLayout()`, `deserializeLayout()`

**完全缺乏测试的模块：**
- `renderer.js`（终端创建、OSC handler、bridge I/O）
- `pane-manager.js`（MRU、focus、拖拽）
- `layout-renderer.js`（DOM 渲染）
- `settings-ui.js`（设置持久化、迁移）
- `input/dispatcher.js`（键盘分发）
- `shortcuts-registry.js`（覆盖计算）

对于无框架的 Vanilla JS 大型应用，缺乏测试意味着任何重构都是高风险的。

#### 7.2 类型安全

**【严重】无 TypeScript。**

由于项目是纯 JS，以下类型风险完全暴露在运行时：
- `st.panes` 中 pane 对象的结构。`restoreSession` 中有部分防御式编程，但 layout 树的结构没有校验。
- `panelDataMap.get(panelId)` 可能返回 `undefined`，但多处代码使用 `??` 兜底，容易遗漏。
- `bridge` 对象的形状在不同平台/环境（Tauri vs unavailable）下略有不同，没有接口约束。
- `settings` 对象的字段类型没有约束，`applyPersistedSettings` 依赖大量 `typeof` 和 `Number.isFinite` 检查。

**建议**：即使不全面迁移到 TS，也应增加 `.d.ts` 文件描述核心数据结构（`Pane`, `PanelNode`, `Settings`, `LayoutNode` 等），并开启 VS Code 的 `@ts-check` 注释以进行部分类型检查。

#### 7.3 文档

- **【良好】** `split-layout.js`、`input/dispatcher.js`、`input/keymap.js`、`pane-activity-watcher.js` 有详尽的 JSDoc 和注释。
- **【中等】** `renderer.js` 中 IME workaround 的注释非常详细，但 `handleMenuAction` 完全没有注释。
- **【低】** `settings-ui.js` 的 `applyPersistedSettings` 中的迁移逻辑（v3→v4→v5）没有版本变迁文档，只能通过代码注释推断。

---

### 8. 具体代码问题（逐文件）

#### 8.1 `src/renderer.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 中等 | 162 | `isWindowsCtrlVPasteHotkey` 中 `event.key.toLowerCase()` 假设 `event.key` 存在。在极少数浏览器事件异常中可能为 `undefined`。 |
| 中等 | 335-378 | Terminal addon 加载中，`WebglAddon` 用 `try {} catch {}` 静默吞掉错误。如果 WebGL 上下文失败，终端会回退到 canvas/DOM，但用户和开发者都不知道发生了什么。应至少 `console.warn`。 |
| 中等 | 404 | `_ta = () => terminalHost.querySelector('textarea.xterm-helper-textarea')` 每次调用都 querySelector，应缓存一次（在 xterm open 后 textarea 已存在）。 |
| 中等 | 567-573 | Broadcast 模式下 `paneNodeMap.values()` 遍历期间可能发生 pane 销毁。建议先收集目标 paneId 到数组再遍历。 |
| 中等 | 1125-1273 | `handleMenuAction` 是巨型 if-else 链，难以扩展和维护。应改为 action 注册表（Map 或对象）模式。 |
| 中等 | 1277-1305 | `keyboardActions` 和 `handleMenuAction` 中的 `fontSizeIncrease/Decrease/Reset` 逻辑完全重复。 |
| 低 | 147 | `abbreviatePath` 中 `home` 为 `bridge.defaultCwd`，但如果 `defaultCwd` 为 `/`，任何以 `/` 开头的路径都会被替换成 `~`，这是错误的（`/` 不是 home）。 |

#### 8.2 `src/pane-manager.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 中等 | 74-78 | `getOwningTabId(panelId)` 对每个 pane 都调用 `collectPanelIds(getTabLayout(p))`，时间复杂度 O(n·m)。当 pane 和 panel 数量大时性能差。应建立 `panelId → paneId` 的反向索引 Map。 |
| 中等 | 192-207 | `closePane` 中先调用 `onDestroyPanel` 遍历所有 panel，然后修改 `st.panes`。如果 `onDestroyPanel` 抛异常，`st` 已处于半清理状态。应使用 try/finally 或事务模式。 |
| 中等 | 236 | `splitPanel` 中 `newPanelId = \`panel-${st.nextPanelSeq++}\``。如果 `nextPanelSeq` 溢出（虽然极难发生），ID 会重复。但更大的问题是 session restore 也会生成 `panel-${st.nextPanelSeq++}`，如果 restore 前已有 panel 使用了相同 seq，会冲突。restore 逻辑在 `renderer.js:1343` 也有相同模式。 |
| 低 | 288-297 | `getPanelDropZone` 中 `edge = 0.25` 是魔法数字，且 drop zone 检测基于鼠标相对于 panel 的位置。对于非常小的 panel（如 200px 宽），edge 区域只有 50px，用户可能难以命中。 |

#### 8.3 `src/layout-renderer.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 中等 | 64-69 | `getTextColorForBackground` 使用简单的 luminance 公式，但对 `#fff` 返回 `'#000'`、`#000` 返回 `'#fff'`。对于 pane accent 颜色，若用户选择接近中灰的颜色（如 `#808080`），luminance ≈ 0.5，返回 `'#fff'`，在深色背景上可读性可能不佳。建议使用 WCAG 对比度公式。 |
| 中等 | 98-99 | `bridge.getSystemInfo()` 在模块初始化时调用一次，失败则静默忽略。如果系统信息获取失败，status bar 的 `\u`, `\h`, `\H` 变量将永远为空，直到应用重启。应增加重试或默认值。 |
| 中等 | 126-206 | `createTab` 每次渲染都重建 DOM 和事件监听器。Tab 数量多时应使用 diff/patch 或事件委托。 |
| 中等 | 274-298 | `renderSplitDividers` 动态创建/销毁 divider DOM 节点。应使用对象池复用。 |
| 低 | 395-408 | Tab divider drag 的 `mousedown` 监听器为每个 divider 单独注册，但 `mousemove`/`mouseup` 是全局的。这导致无法支持 touch 事件（Tauri 桌面端可能不太需要，但未来如果有平板模式会有问题）。 |

#### 8.4 `src/settings-ui.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 严重 | 156-171 | 字体检测逻辑在 `document.fonts.ready.then()` 中执行，但没有 catch 处理 `document.fonts.ready` 被拒绝的情况（虽然罕见）。更关键的是，canvas 检测在 then 回调内部同步执行，如果字体列表很长会阻塞 microtask。 |
| 中等 | 285-335 | `applyPersistedSettings` 包含 v3→v4→v5 的迁移逻辑，内联在函数中。随着版本增加，这个函数会无限膨胀。应提取为 `migrations/` 目录下的版本链。 |
| 中等 | 397-409 | `loadShellProfiles()` 是异步的，但不返回 Promise。调用方（如 `openShellProfilesSubPage`）无法知道何时加载完成。在慢机器上，用户可能看到空列表数秒。 |
| 中等 | 450-574 | `renderModalShellProfiles` 过长，且每次渲染都完全重建 DOM。Shell profile 数量多（如 50+）时性能差。 |
| 中等 | 756 | Settings panel 的 click 事件处理器调用 `event.stopPropagation()`，这会阻止事件冒泡到 `window` 的 `pointerdown` 监听器（该监听器用于点击外部关闭 settings）。虽然代码中 `pointerdown` 在 window 上，stopPropagation 不影响它，但如果未来改为事件委托模式，这里会引入 bug。 |
| 中等 | 908-931 | `window.addEventListener('keydown', ...)` 直接处理 `Escape`、`Cmd+,`、字体大小，绕过中央 dispatcher。这造成快捷键处理的双轨制。 |
| 低 | 229 | `applyColorMode` 中对每个 pane 设置 `node.terminal.options.theme`。`options.theme` 是一个对象引用，xterm.js 在内部可能深比较或浅比较，如果直接赋新对象会触发全量重绘。当前实现每次 theme 变化都新建对象，这是必要的，但可考虑缓存 theme 对象。 |

#### 8.5 `src/split-layout.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 低 | 47, 52 | `computeLayout` 中使用 `Math.round((w - DIVIDER_PX) * ratio)`。在深层嵌套树中，多次 rounding 可能导致总像素数与容器差 1-2px，出现微小缝隙。建议使用 remainder distribution（将剩余像素分配给最后一个叶子）来保证精确填充。 |
| 低 | 70 | `collectDividers` 返回的 `usableSize` 仅在 drag 时使用，命名合理。但 `computeLayout` 和 `collectDividers` 中的 width/height 计算逻辑完全重复，未来修改 divider 宽度时容易只改一处。应提取 `calcSplitSize` 辅助函数。 |

#### 8.6 `src/terminal-bridge.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 低 | 94-101 | `base64Encode` 手动将 bytes 转为 binary string再 `btoa`。对于大输出（如粘贴多 MB 文本），`String.fromCharCode(...bytes.subarray(...))` 的参数展开有栈大小限制。虽然当前分片为 8192 bytes，但 `btoa` 本身也有输入长度限制（各浏览器不同，通常 ~100MB）。对于终端应用，这基本够用，但应记录此限制。 |
| 低 | 113 | `platform: getRuntimePlatform()` 在 `createTauriBridge` 和 `createUnavailableBridge` 中都调用。在 Tauri 中，`navigator.platform` 返回的是宿主 OS 的 platform，与 Tauri 的 `os.platform()` 一致，这是正确的。 |

#### 8.7 `src/shortcuts-registry.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 中等 | 97-98 | `overrideMatchesDefault` 使用 `JSON.stringify([...shortcut.modifiers].sort())` 比较数组。每次比较都创建新数组、排序、序列化，时间复杂度 O(m log m)。modifiers 数量很小（≤4），但这是一种反模式。应使用固定顺序的 tuple 比较。 |
| 低 | 65 | `overrides` 是普通对象。虽然键是字符串 id，没问题，但用 `Map` 语义更清晰。 |

#### 8.8 `src/shortcuts-ui.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 中等 | 117-181, 257-367 | `renderIntoContainer` 和 `renderModalShortcuts` 的列表渲染逻辑几乎完全相同，只是容器和回调不同。应提取为公共的 `renderShortcutsList(container, onRecord)` 函数。 |
| 低 | 220-224 | 平台检测在事件处理中重复 4 次：`navigator.platform.toLowerCase().includes('mac')`。应在模块顶部计算一次 `const IS_MAC = navigator.platform.toLowerCase().includes('mac')`。 |
| 低 | 77-112 | `showConfirmDialog` 每次调用都创建新 DOM 和监听器，且返回的 Promise 没有超时或外部取消机制。如果调用方忘记处理，overlay 会永远停留。 |

#### 8.9 `src/command-palette.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 中等 | 68-73 | 每次打开 palette 都新建 `Fuse` 索引。如果 items 数量大（如 1000+）且 palette 被频繁打开，这是重复工作。可考虑缓存 Fuse 实例（以 items 引用为 key）。 |
| 低 | 83-93 | `updateHighlight` 中对所有 rows 做 `classList.toggle` 和 `scrollIntoView`。当结果很多时，`scrollIntoView` 的调用次数等于高亮行号，虽然浏览器会优化，但直接滚动到目标行一次即可。 |

#### 8.10 `src/input/dispatcher.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 中等 | 31-36 | `createDispatcher` 返回的 `dispatch` 函数每次执行都重新计算 `mode`、`inputFocused`、`paletteOpen`，然后线性扫描整个 keymap。keymap 长度目前约 30 条，完全可忽略。但如果未来增长到数百条，应考虑按 mode 预分组 keymap。 |
| 低 | 38-50 | `cachedKeymap` 使用引用比较（`km !== cachedKeymap`）。由于 `activeKeymap` 在 overrides 变化时返回**新数组引用**，这能工作。但如果调用方不小心返回了同一个数组的修改版（in-place mutation），缓存会失效。文档中应强调 `getKeymap()` 必须返回新引用。 |

#### 8.11 `src/input/keymap.js`

| 优先级 | 行号 | 问题描述 |
|---|---|---|
| 低 | 99 | `parseChordAlt` 中的 `/^\d\.\.\d$/` 不验证 `lo <= hi`。如果 keymap 写错为 `'9..1'`，`matchesChordAlt` 中 `digit < lo \|\| digit > hi` 会永远为 true，导致该绑定静默失效。 |
| 低 | 173-177 | `?` 键的特殊处理注释充分，但逻辑上如果 future keymap 加入其他需要 Shift 的符号（如 `@`、`#`、`$`），都需要在这里加特例。应考虑更通用的"符号键是否需要忽略 Shift"的检测机制。 |

---

### 9. 总结与优先级排序（剩余未修复）

#### 严重（应立即修复）

1. **测试覆盖缺失**：除 `split-layout.js` 外无任何单元测试。对于持续维护，至少应为 `input/dispatcher.js`、`shortcuts-registry.js`、`pane-manager.js` 的核心逻辑添加测试。

#### 中等（应在下个迭代处理）

2. **`st` 与 `settings` 的全局可变状态**：考虑引入最小化的状态变更通知机制，或至少统一所有 `settings` 修改走同一入口。
3. **`renderer.js` 过重**：将 `createPane`（终端创建+IME workaround）、`handleMenuAction`、颜色选择器、命令面板封装等提取到独立模块。
4. **Tab 渲染完全重建**：使用事件委托或 diff 算法避免每次 `renderTabs` 重建所有 DOM 节点和监听器。
5. **Split divider DOM 未池化**：参照 tab dividers 使用固定 DOM 池。
6. **`applyPersistedSettings` 版本迁移内联**：提取为独立的 migration pipeline。
7. **`getOwningTabId` 性能**：建立 panelId → paneId 的反向索引。
8. **`handleMenuAction` 巨型 if-else**：重构为 action registry 模式。

#### 低（技术债，有机会时清理）

9. 魔法数字提取为命名常量。
10. `shortcuts-ui.js` 中重复的平台检测提取到模块级变量。
11. `renderIntoContainer` / `renderModalShortcuts` 提取公共渲染逻辑。
12. `abbreviatePath` 对 `/` 作为 home 的错误处理。
13. `getTextColorForBackground` 改用 WCAG 对比度算法。
14. `command-palette.js` 中 Fuse 实例缓存。
15. `split-layout.js` 的 rounding 误差累积问题。
16. 增加核心数据结构的 JSDoc / `.d.ts` 类型定义。

---

## 二、性能与 UX

### 1. 渲染性能

#### 🟡 中等：`renderTabs()` 全量 DOM 重建导致 Tab 切换时布局抖动

**文件**：`src/layout-renderer.js` (L211-243)

```js
function renderTabs() {
  // ...
  tabsListEl.replaceChildren(
    ...st.panes.map((pane, index) => {
      // ... 每次调用都创建全新的 DOM 节点
      return createTab(pane, index, focusedIndex, dragMeta);
    })
  );
}
```

**问题**：`renderTabs()` 在 `sig`（签名）变化时执行全量 `replaceChildren`，每次都会销毁并重建所有 tab DOM 节点。虽然只有 sig 变化时才重建，但在 rename、add、close pane 等操作中，这会触发：
- 所有 tab 的 CSS transition 重新计算
- 输入框焦点丢失（rename 时）
- 布局抖动（Layout Thrashing），尤其在 tab 数量 >10 时

**建议**：引入 Diff 策略，仅更新变化的 tab（属性、class、文本），保留未变化的 DOM 节点。

---

#### 🟡 中等：`applyPanelStyle` 密集样式写入可能触发多次重排

**文件**：`src/layout-renderer.js` (L247-270)

```js
function applyPanelStyle(node, accentColor, x, y, w, h, zIndex, isFocused, hasSplits) {
  node.root.classList.toggle('is-focused', isFocused);
  // ... 连续 8+ 次样式写入
  node.root.style.left = `${x}px`;
  node.root.style.top  = `${y}px`;
  node.root.style.width  = `${w}px`;
  node.root.style.height = `${h}px`;
  // ...
}
```

**问题**：`renderPanes` 对每个可见 pane 调用 `applyPanelStyle`，设置多个独立的 style 属性。浏览器无法批量优化，可能触发多次重排（Reflow）。虽然使用了 `willChange: 'transform'` 将部分面板提升至合成层，但 `width`/`height` 仍触发布局计算。

**建议**：使用 `CSSStyleDeclaration.cssText` 一次性写入所有样式，或将几何属性封装为 CSS 自定义属性 `--pane-x`、`--pane-y` 等，利用 Houdini 或简单的 `transform: translate3d()` + `scale()` 完全避开布局。

---

#### 🟢 低：`willChange` 策略基本正确，但存在短暂悬空风险

**文件**：`src/renderer.js` (L295-297), `src/layout-renderer.js` (L257)

```js
paneEl.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'transform') paneEl.style.willChange = '';
}, { signal });
```

**问题**：`willChange` 在 transition 开始时设置、结束后清除，策略正确。但 `layout-renderer.js` 的 `applyPanelStyle` 中每次都会重新设置 `willChange = 'transform'`，对于 splits 布局（`hasSplits=true`）则会清除。这意味着在频繁切换 pane（如快速 cycle tabs）时，合成层的创建/销毁开销可能累积。

**建议**：仅在 pane 从 `display: none` 变为可见，或从非 split 变为非 split 且位置变化时设置 `willChange`，避免每次 render 都重复赋值。

---

#### 🟢 低：`getBoundingClientRect()` 在拖拽期间被频繁调用

**文件**：`src/pane-manager.js` (L299-311)

```js
function getHoveredPanelInfo(mouseX, mouseY, excludeId) {
  for (const [panelId, node] of paneNodeMap.entries()) {
    const rect = node.root.getBoundingClientRect();  // ← 强制同步布局
    // ...
  }
}
```

**问题**：Panel drag 的 mousemove handler 虽被 `rafThrottle` 限制到 60/120Hz，但内部遍历所有 pane 并调用 `getBoundingClientRect()`，这会强制浏览器同步计算布局（Forced Synchronous Layout）。在 split 布局复杂（如 8+ panels）时，每帧都可能触发 FSL。

**建议**：在 drag 开始时缓存所有 panel 的 `getBoundingClientRect()` 结果，mousemove 期间仅做矩形碰撞检测，避免重复读取布局。

---

### 2. 滚动性能

#### 🟢 低：Wheel 事件拦截策略正确，但缺少 Touch 设备适配

**文件**：`src/renderer.js` (L511-530)

**优点**：
- 使用 `capture: true, passive: false` 正确拦截 xterm.js 的默认 wheel 处理
- 自定义的 `_scrollAccum` 累积器避免了 ProMotion 120Hz 下小 delta 的精度丢失
- 正确处理了 `DOM_DELTA_LINE`/`DOM_DELTA_PAGE`/`DOM_DELTA_PIXEL` 三种模式

**隐患**：
- 仅处理了 `wheel` 事件，未处理触控板/触摸屏的 `touchmove` 或 `scroll` 事件。在 macOS 上双指滑动实际上也触发 `wheel`，但在某些 Linux 触控板驱动上可能行为不一致。
- `fastScrollSensitivity` 的读取方式 `terminal.options.fastScrollSensitivity ?? 5` 在 xterm.js 5.x+ 中该 option 可能不存在，导致 fallback 为 5，对普通用户而言可能过于激进。

---

#### 🟢 低：Scrollback 内存上限未做动态限制

**文件**：`src/renderer.js` (L346), `src/settings-ui.js` (L22)

```js
scrollback: settings.scrollback,  // 默认 5000，最大可设为 50000
```

**问题**：xterm.js 的 scrollback buffer 在内存中保存完整的 `BufferLine` 数组。在 8 个 pane、每个 scrollback 50000 行、每行 200 字符的极端场景下，内存占用可达 **~1.5GB**（估算：50000 × 200 × 2 bytes × 8 panes × 开销系数 ≈ 1.2-1.8GB）。对于长时间运行的 Agentic Coding session，这是潜在风险。

**建议**：
1. 对后台 pane 自动降低 scrollback 至 1000-2000 行。
2. 或提供 "Auto-trim background pane scrollback" 设置项。

---

### 3. 启动性能

#### 🟡 中等：首屏渲染被阻塞于 Bridge 就绪等待链

**文件**：`src/renderer.js` (L1404-1430), `src/index.html`

**问题**：
1. `bridge.cwdReady` 和 `bridge.loadSettings()` 是顺序 await，可能耗时 50-300ms（取决于磁盘速度和 session 大小）。
2. `renderer.js` 作为 `type="module"`，其解析和执行会阻塞 `DOMContentLoaded`。
3. 三个初始 pane 同步创建，每个 pane 都加载 WebGL addon、解析 CSS，在低端设备上可能导致首帧延迟 >200ms。

**建议**：
1. 在 `index.html` 中预连接字体（如使用 `<link rel="preload">` 对 Menlo/Consolas）。
2. 将 `bridge.loadSettings()` 与 `bridge.cwdReady` 并行化：`await Promise.all([bridge.cwdReady, bridge.loadSettings()])`。
3. 考虑对初始 pane 使用延迟初始化（staggered init），优先渲染 focused pane，其余在下一帧创建。

---

#### 🟢 低：CSS 加载阻塞渲染

**文件**：`src/index.html` (L10)

```html
<link rel="stylesheet" href="./styles.css" />
```

**问题**：`styles.css` 体积较大（约 2700 行），作为 render-blocking resource，在 Tauri WebView 首次加载时会阻塞首屏。虽然本地文件读取很快（<5ms），但在 Windows 上 WebView2 的 CSS 解析可能比 macOS 慢 20-40%。

**建议**：将首屏关键 CSS（app-shell、tabs-panel、stage、pane 基础样式）内联至 `<style>`，异步加载完整样式。

---

### 4. 交互响应

#### 🟢 低：Panel Drag 的 Ghost 创建有 6px 阈值，但无视觉反馈

**文件**：`src/pane-manager.js` (L348-366)

```js
if (!panelDragState.active) {
  if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
  panelDragState.active = true;
  const ghost = document.createElement('div');
  // ...
}
```

**问题**：用户拖动 panel title 前 6px 没有任何视觉反馈，可能误以为拖拽未生效。iTerm2 和 VS Code 在此阶段会显示 cursor:grabbing 或轻微缩放提示。

**建议**：在 mousedown 时立即给 panel header 添加 `cursor: grabbing` 或轻微 scale 动画，即使未超过 6px 阈值。

---

#### 🟢 低：键盘事件在 Navigation Mode 下无节流

**文件**：`src/renderer.js` (L1315)

```js
window.addEventListener('keydown', dispatchKeydown, true);
```

**问题**：`dispatchKeydown` 在 nav mode 下处理方向键切换 pane 时没有防抖/节流。用户长按方向键时，会以系统重复速率（通常 30-50Hz）连续触发 `onRender()` → `renderPanes()`，可能在高负载时导致掉帧。

**建议**：对 nav mode 的方向键增加 80-120ms 的 throttle，确保渲染管线不被键盘重复事件压垮。

---

### 5. 内存使用

#### 🟡 中等：`paneNodeMap` 等 Map 在异常路径下可能泄漏

**文件**：`src/renderer.js` (L86-91, L178-190)

```js
const paneNodeMap = new Map();
const panelDataMap = new Map();
const activeCwdMap = new Map();
const splitDividerElMap = new Map();
```

**问题**：`destroyPanelNode` 会清理 `paneNodeMap`/`panelDataMap`/`activeCwdMap`，但 `splitDividerElMap` 的清理在 `layout-renderer.js` 中。如果 `renderSplitDividers` 未被调用（如异常路径），`splitDividerElMap` 中的 DOM 引用不会被释放。

此外，`panelDataMap` 中存储的 `breathingMonitor` 等对象在 pane 关闭后，若 `getTabLayout` 未包含该 panelId，`destroyPanelNode` 会清理，但 `ensurePaneNodes` 的循环中若 `panelDataMap.get(panelId)` 返回旧数据，可能导致状态不一致。

**建议**：
1. 在 `destroyPanelNode` 中增加断言：确保 `splitDividerElMap` 中无残留对该 pane 的 divider 引用。
2. 定期（如 pane 关闭后）执行 `paneNodeMap.size === 活跃 panel 数量` 的一致性检查（开发模式）。

---

#### 🟢 低：`states` Map 在 `pane-activity-watcher` 中未设置上限

**文件**：`src/pane-activity-watcher.js` (L68)

```js
const states = new Map();
```

**问题**：虽然 `forget(paneId)` 会删除 state，但如果宿主代码未调用 `forget`（如 bridge 异常断开），states 会持续累积。在长时间运行的 session 中（如 Agent 连续工作 8+ 小时，不断创建/销毁 pane），这是潜在泄漏点。

**建议**：添加 `states.size` 上限（如 256），超限时报 warning 并自动清理无 timer 的孤儿 state。

---

#### 🟢 低：xterm.js ImageAddon 的图像数据未主动清理

**文件**：`src/renderer.js` (L377)

```js
terminal.loadAddon(new ImageAddon());
```

**问题**：`ImageAddon` 会将终端中的图像数据缓存在内存中。在 Agentic Coding 场景下，后台 pane 可能输出大量图像（如 AI 生成的图表、截图），这些图像数据即使 pane 被隐藏也不会自动释放。

**建议**：在 pane 变为不可见时，调用 `terminal.clear()` 或 ImageAddon 的清理 API（如有）。

---

### 6. 电池/能耗

#### 🟢 低：定时器数量随 Pane 数量线性增长

**文件**：`src/pane-activity-watcher.js` (L147-154), `src/renderer.js` (L1395-1402)

**问题**：
- `pane-activity-watcher` 为每个后台 pane 维护独立的 `setTimeout`（settleMs = 1500ms）。
- `renderer.js` 的 resize debounce 使用 `setTimeout`（120ms）。
- 全屏检测使用 `setTimeout`（350ms、4000ms、600ms 等）。

这些定时器数量与 pane 数量成正比。在 20+ pane 的场景下，可能同时存在 20+ 个 active timeout，增加事件循环负担。

**建议**：
1. 将 `pane-activity-watcher` 的 per-pane timer 合并为单个全局 `setInterval`（如 100ms tick），用时间戳比较代替独立 timer。
2. 统一 resize debounce 和 fullscreen check timer，避免多个独立的 timer。

---

### 7. UX 设计

#### 🟡 中等："一主多从" 布局在 Pane 数量 >5 时预览宽度过度压缩

**文件**：`src/pane-manager.js` (L22-26)

```js
export function getPreviewWidth(stageWidth, count, paneWidth) {
  if (count <= 1) return 0;
  if (stageWidth >= paneWidth * count) return paneWidth;
  return (stageWidth - paneWidth) / (count - 1);  // ← 可能 <100px
}
```

**问题**：当 stageWidth = 1440px、paneWidth = 720px、count = 6 时，预览宽度 = (1440-720)/5 = **144px**。xterm.js 在如此窄的宽度下只能显示约 15-20 列字符，几乎无法阅读任何内容，失去了"预览"的意义。

**建议**：
1. 设置预览宽度下限（如 280px），超限 pane 以堆叠/滚动或抽屉形式呈现。
2. 或引入 "minimap" 模式：预览 pane 仅显示终端内容的缩略/高亮行，而非完整渲染。

---

#### 🟡 中等：Navigation Mode 的认知负荷较高

**文件**：`src/pane-manager.js` (L582-598)

**问题**：
1. 进入 nav mode 后，tab bar 上的 swatch 显示数字（1/2/3...），但 pane 本身没有数字标注，用户需要在 tab 和 pane 之间做视觉映射。
2. 状态栏提示使用 `hint-bar.js` 动态生成，但在 nav mode 下的提示信息（如 "j/k 切换 tab，Enter 进入"）可能被长路径名截断。
3. 没有持久化的 nav mode 入口提示，新手用户可能不知道 `Ctrl+[` 或等效快捷键的存在。

**建议**：
1. 在 nav mode 下，给每个 pane 叠加半透明的数字 badge（类似 Vim 的 easymotion）。
2. 首次启动时显示一次性的 "导航模式" 引导 toast。

---

#### 🟢 低：命令面板缺少最近使用 (MRU) 排序和快捷键提示

**文件**：`src/command-palette.js` (L145-155)

```js
function applyQuery(query) {
  if (!trimmed) {
    currentResults = items.map((item) => ({ item, matches: [] }));
  } else {
    currentResults = fuse.search(trimmed);
  }
}
```

**问题**：空查询时按原始顺序显示 items，未根据 MRU 排序。tab switcher 作为高频功能，用户期望最近访问的 tab 排在最前（类似 VS Code 的 Ctrl+Tab）。

**建议**：
1. 空查询时按 `paneMruOrder` 排序。
2. 给每个 item 右侧显示快捷键（如 "⌘1"、"⌘2"）。

---

#### 🟢 低：Tab 重命名输入框无 ESC/Enter 的键盘陷阱提示

**文件**：`src/layout-renderer.js` (L158-186)

**问题**：重命名 tab 时，输入框捕获所有键盘事件。虽然实现了 Enter 确认和 Escape 取消，但没有 `aria-describedby` 提示这些操作，屏幕阅读器用户可能不知所措。

**建议**：给输入框添加 `aria-describedby` 指向一个隐藏的提示文本（"按 Enter 确认，按 Esc 取消"）。

---

### 8. 无障碍

#### 🟡 中等：Pane 区域缺少 ARIA 地标和 Live Region

**文件**：`src/index.html`, `src/renderer.js`

**问题**：
1. `stage` 区域（`#stage`）虽有 `aria-label="Pane stage"`，但每个 pane（`article.pane`）没有 `aria-label` 或 `role="region"`，屏幕阅读器无法告知用户当前有多少 pane、哪个是聚焦的。
2. 状态栏（`#status-label`）更新路径（CWD、模式切换）没有 `aria-live` 属性，屏幕阅读器用户不会收到反馈。
3. 呼吸灯动画（视觉提示后台活动）没有对应的音频或 ARIA live 提示，视障用户完全感知不到后台 pane 的活动。

**建议**：
1. 每个 pane 添加 `aria-label="Terminal ${paneId}"` 和 `aria-hidden={!isFocused}`（对非聚焦 pane）。
2. `#status-label` 添加 `aria-live="polite"`。
3. 当 `paneActivityWatcher` 触发 `onAlert` 时，向一个隐藏的 `aria-live="polite"` 元素写入 "Pane ${paneId} has new output"。

---

#### 🟡 中等：颜色对比度在浅色模式下未完全验证

**文件**：`src/styles.css`

**问题**：
- 浅色模式下 `theme-light .tab` 的 `color: rgba(0, 0, 0, 0.40)` 在 `#f5f1eb` 背景上的对比度约为 **2.8:1**，低于 WCAG AA 的 4.5:1 标准。
- `theme-light .settings-caption` 的 `color: rgba(0, 0, 0, 0.38)` 对比度约 **2.6:1**。
- 深色模式下 `color: rgba(255, 255, 255, 0.45)` 在 `#1d1d1d` 背景上对比度约 **3.8:1**，接近但未达到 4.5:1。

**建议**：
1. 将 `tab` 非聚焦状态的透明度提升至 0.55（浅色）/ 0.60（深色）。
2. 使用 [APCA](https://www.myndex.com/APCA/) 或 WCAG 2.1 对比度计算器对所有文本颜色做系统性审计。

---

#### 🟢 低：Reduced Motion 覆盖不完整

**文件**：`src/pane-alert-breathing-mask.css` (L31-39), `src/styles.css`

**优点**：呼吸灯动画已为 `prefers-reduced-motion: reduce` 提供静态替代样式。

**问题**：
- `.pane` 的 `transition: transform 150ms cubic-bezier(...), box-shadow 120ms ease` 在 Reduced Motion 下仍然运行。
- `.tab` 的 `transition: background 120ms ease, color 120ms ease, transform 120ms ease` 同样未禁用。
- 全屏模式下 menu-bar 的 `transition: transform 0.22s ease` 未禁用。

**建议**：在全局添加：
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

#### 🟢 低：搜索栏缺少 `aria-live` 和角色标注

**文件**：`src/index.html` (L170-176)

**问题**：
- `#search-count` 虽有 `aria-live="polite"`，但初始状态为空，屏幕阅读器可能不会读取 "No results"。
- 搜索输入框没有 `role="searchbox"`（虽然父级有 `role="search"`）。
- 没有 `aria-expanded` 或 `aria-controls` 关联搜索结果。

**建议**：给 `#search-input` 添加 `aria-controls="search-count"` 和 `aria-describedby="search-count"`。

---

### 9. 逐文件优化建议汇总（剩余未修复）

#### `src/renderer.js`（~1485 行）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟡 中等 | 启动链顺序执行，无并行化 | `Promise.all([bridge.cwdReady, bridge.loadSettings()])` |
| 🟡 中等 | 初始 3 pane 同步创建阻塞首帧 | Staggered init：focused pane 立即创建，其余 requestIdleCallback |
| 🟢 低 | `ImageAddon` 无图像清理 | pane 隐藏时调用 `terminal.clear()` 清理图像缓存 |
| 🟢 低 | `fixXtermViewportBg` 同步查询 DOM | 缓存 viewport 引用，避免重复 querySelector |
| 🟢 低 | 键盘长按无节流 | nav mode 方向键增加 80ms throttle |

#### `src/layout-renderer.js`（~511 行）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟡 中等 | `renderTabs` 全量重建 DOM | 实现 diff 更新，复用未变化的 tab 节点 |
| 🟡 中等 | `applyPanelStyle` 多次样式写入 | 使用 `cssText` 一次性写入，或改用 CSS 自定义属性 |
| 🟢 低 | `willChange` 重复赋值 | 仅在 visibility 变化时设置，避免每帧重复 |
| 🟢 低 | `getBoundingClientRect` 在拖拽中重复调用 | drag 开始时缓存 rect，mousemove 只做碰撞检测 |
| 🟢 低 | `renderPanes` 无防抖 | resize 期间对 `renderPanes` 做 16ms debounce |

#### `src/pane-manager.js`（~680 行）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟢 低 | Panel drag 6px 阈值无反馈 | mousedown 时立即添加 grabbing cursor |
| 🟢 低 | `paneMruOrder` 每次访问都 filter | 使用 Set 维护活跃 pane 集合，降低 `syncPaneMruOrder` 复杂度 |
| 🟢 低 | `getTabsSig` 字符串拼接频繁 | 使用数组 join 缓存，或计算 hash 替代完整字符串 |

#### `src/pane-activity-watcher.js`（~209 行）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟢 低 | `states` Map 无上限 | 添加 size 上限（256），超限自动清理孤儿 state |
| 🟢 低 | 每个 pane 独立 setTimeout | 合并为全局 100ms tick，用时间戳比较 |

#### `src/pane-alert-breathing-mask.js` / `.css`

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟢 低 | 动画不可见 pane 仍运行 | 配合 `IntersectionObserver`，不可见 5s 后移除动画 class |
| 🟢 低 | `max(0.7, calc(1 - var(--pane-bg-mask-opacity)))` 计算开销 | 预计算为 CSS 自定义属性，避免每帧函数计算 |

#### `src/split-layout.js`（~171 行）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟢 低 | `computeLayout` 递归创建大量调用帧 | 对于深度 >8 的树，考虑迭代实现或尾递归优化 |
| 🟢 低 | `Math.round` 累积误差 | 使用 `Math.floor` + 余量分配，避免叶子节点总宽高差 1-2px |

#### `src/command-palette.js`（~268 行）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟡 中等 | 空查询无 MRU 排序 | 按 `paneMruOrder` 排序空查询结果 |
| 🟢 低 | 无虚拟列表 | items >50 时渲染延迟，可引入简单 windowing |
| 🟢 低 | `renderHighlightedLabel` 每次创建 TextNode | 使用 DocumentFragment 批量插入 |

#### `src/styles.css`（~2692 行）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| 🟡 中等 | 浅色模式对比度不足 | tab 文字透明度 0.40 → 0.55；caption 0.38 → 0.50 |
| 🟡 中等 | ARIA live region 缺失 | `#status-label` 添加 `aria-live="polite"` |
| 🟢 低 | Reduced Motion 未全局覆盖 | 全局 `* { animation/transition-duration: 0.01ms }` |
| 🟢 低 | CSS 体积大，阻塞渲染 | 关键 CSS 内联，其余异步加载 |
| 🟢 低 | `color-mix()` 使用频繁 | 在支持的浏览器上性能良好，但老旧 WebKit 可能较慢；可预计算变量 |

---

## 三、Rust 后端

### 1. 架构设计

#### 1.1 总体评价

项目采用经典的 Tauri 2 分层结构：
- `lib.rs` 作为 crate root，导出模块并承载全局原子状态 `IS_LIGHT_MODE`
- `commands/` 按功能域拆分命令模块（terminal、settings、wsl 等），边界清晰
- `pty.rs` 作为核心域模块，封装 `portable-pty` 的交互细节
- `wsl.rs` 独立封装 Windows WSL 支持，带有良好的平台隔离

#### 1.2 模块职责

| 模块 | 职责 | 评价 |
|------|------|------|
| `main.rs` | 应用入口、菜单构建、事件路由 | **过重**。约 200+ 行菜单构建逻辑与生命周期回调混杂，应抽取到 `menu.rs` 或 `app_setup.rs` |
| `lib.rs` | 模块声明、全局原子状态 | 合理，足够精简 |
| `pty.rs` | PTY 生命周期、Shell 解析、命令构建、目录解析、平台 fallback | **过重且耦合**。将 I/O 密集型设置读取、Shell 候选链、PATH 查找全部塞入一个文件，违反单一职责原则 |
| `commands/*.rs` | IPC 命令实现 | 合理，命令层很薄，业务逻辑下沉到 `pty.rs` 或 `wsl.rs` |
| `wsl.rs` | WSL 检测、路径转换、环境桥接 | 优秀。文档详尽，测试覆盖充分，平台隔离干净 |

#### 1.3 耦合度问题

- **`pty.rs` 隐式依赖 `commands/settings.rs`**：
  - `load_settings_config()` 和 `extract_profiles()` 在 `pty.rs` 内部重新定义，直接读取磁盘上的 `settings.json`。
  - 这导致 **PTY 核心层与设置持久化层耦合**，且出现代码重复（与 `commands/settings.rs` 的 `settings_path`、`sanitize_config` 逻辑重叠）。
  - **建议**：`PtyManager::spawn()` 应通过参数接收 `ShellProfile` 列表，而非自己读盘。上层 `terminal_create` 命令负责读取并注入。

- **设置模块双向耦合**：
  - `commands/settings.rs` 定义了配置 schema 和清洗逻辑。
  - `commands/shell_profile.rs` 又自行读取 settings 并局部修改后写回。
  - `pty.rs` 也读同一份文件。
  - 配置读写逻辑分散在三处，没有统一的 SettingsStore 抽象。

---

### 2. 并发安全

#### 2.1 锁策略

`PtyManager` 使用单一的 `Mutex<HashMap<String, PtySession>>`：

```rust
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}
```

- **粗粒度锁**：所有读、写、resize、destroy 操作都竞争同一把锁。在终端高并发场景（广播输入、批量 resize）下会成为瓶颈。
- **锁持有时间过长**：`write()` 在持有锁的同时执行 `write_all` + `flush` 系统调用。虽然 PTY 写入通常很快，但在极端负载下会阻塞其他 pane 的操作。
- **无锁替代可行**：可考虑 `dashmap::DashMap<String, PtySession>` 替代 `Mutex<HashMap>`，避免全局串行化。

#### 2.2 线程生命周期

`PtySession` 持有两个线程句柄：

```rust
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    _reader_thread: std::thread::JoinHandle<()>,
    exit_thread: std::thread::JoinHandle<()>,
}
```

- **读线程**：阻塞在 `reader.read(&mut buf)`，持有 `AppHandle` 和 `pane_id` 的克隆。线程安全，因为 `AppHandle` 是 `Send + Sync`。
- **退出监控线程**：阻塞在 `child.wait()`，完成后通过 `Arc<Self>` 移除 session。这是正确的自引用模式。

#### 2.3 死锁与阻塞风险

| 场景 | 风险等级 | 说明 |
|------|----------|------|
| `destroy()` 中 `exit_thread.join()` | **中** | 若子进程忽略 SIGKILL 或内核 stuck，join 会无限阻塞。此时 `Mutex` 已释放（良好），但调用方（如前端 IPC）会被挂起。建议加 `join_timeout` 或文档说明 |
| `spawn()` 中 `self.destroy(pane_id)` | **低** | 先销毁再创建，无死锁，但 `destroy` 中的 join 会阻塞 spawn 调用 |

#### 2.4 Arc 克隆模式

`spawn()` 接收 `&Arc<Self>` 并克隆给退出监控线程：

```rust
pub fn spawn(self: &Arc<Self>, ...)
```

这是 Rust 中典型的 "shared ownership for self-referential cleanup" 模式，**正确且必要**。

---

### 3. 错误处理

#### 3.1 Result/Option 策略

- 命令层统一使用 `Result<(), String>` 返回错误给前端，**对于 Tauri IPC 场景是可接受的**，但不利于后端内部错误分类。
- `String` 错误导致前端无法程序化区分 "PTY 打开失败"、"Shell 未找到"、"权限不足" 等错误类型。
- **建议**：内部定义 `enum PtyError { OpenFailed(...), ShellNotFound(...), ... }`，在命令边界处再转为字符串。

#### 3.2 Panic 风险点

| 位置 | 风险 | 等级 |
|------|------|------|
| `pty.rs:38` `Regex::new(...).expect("static regex is valid")` | 静态正则，实际不会 panic，但可用 `const_regex` 或 `OnceLock` + `unwrap()` | 低 |
| `settings.rs:355, 376` `unreachable!()` | 依赖 `version.is_some()` 推导出 `as_object()` 必然成功。逻辑上成立，但如果未来重构引入竞态或数据竞争，`unreachable!` 会 panic | **中** |
| `settings.rs:163, 368` `expect("json!({}) is always an Object")` | `serde_json::json!({...})` 构建的对象在编译期保证为 Object，安全 | 低 |

#### 3.3 静默吞错（`let _ = ...`）

代码中大量使用 `let _ =` 忽略错误：

- `pty.rs:227-234` 读线程 flush pending bytes 时 emit 失败被忽略
- `pty.rs:265-271` 退出事件 emit 失败被忽略
- `pty.rs:357` `killer.kill()` 失败被忽略
- `main.rs:249, 256` 菜单事件 emit 失败被忽略
- `notification.rs:6` 通知显示失败被忽略

**影响**：在生产环境中，如果事件通道满或窗口已关闭，这些错误被静默丢弃，用户和开发者都无从知晓。建议至少使用 `log::warn!` 记录。

---

### 4. 资源管理

#### 4.1 PTY 生命周期

**正常路径（`destroy()`）**：
1. 获取 MutexGuard
2. 从 HashMap remove session
3. 调用 `killer.kill()`
4. Drop MutexGuard
5. `join(exit_thread)`

**步骤 2-4 的顺序是关键**：先 remove 再 kill，保证 kill 后退出线程能获取锁并 remove（但此时已 remove，实际会找不到 key，无害）。

**问题**：`killer.kill()` 发送 SIGKILL 后，`child.wait()` 可能不立即返回（僵尸进程或内核延迟）。`join()` 阻塞期间，读线程仍在运行，直到 `master` 被 drop 后读端收到 EOF。

#### 4.4 文件句柄与内存

- `settings.json` 在各处被反复 `read_to_string`，无缓存，但文件很小，影响可忽略。
- `portable-pty` 的 `MasterPty` 和 `ChildKiller` 通过 `Box<dyn ...>` 持有，依赖 trait object 的 drop，符合 RAII。
- `writer: Box<dyn Write + Send>` 在 `write()` 时通过 `MutexGuard` 可变借用，安全。

---

### 5. 性能

#### 5.1 I/O 热点：`spawn()` 每次读盘（中等）

`PtyManager::spawn()` → `shell_candidates()` → `load_settings_config()` → 读取 `settings.json`。

**影响**：每次创建终端都触发一次磁盘 I/O + JSON parse。在快速新建多个 pane 时（如恢复 session），这会成为明显瓶颈。

**建议**：`AppState` 中缓存设置，或 `PtyManager` 接收 `Vec<ShellCandidate>` 作为参数。

#### 5.2 IPC 事件风暴（中等）

读线程每次从 PTY read 到数据（最多 8KB）就 emit 一次 Tauri 事件：

```rust
let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
let _ = app_reader.emit("vibe99:terminal-data", ...);
```

- **当子进程大量输出时**（如 `cat /dev/urandom`、`yes`、`ls -R /`），事件频率极高。
- Tauri 的 WebView 事件通道有容量限制（取决于平台实现），高频 emit 可能导致：
  - 前端事件队列堆积，渲染卡顿
  - 内存暴涨（如果前端处理速度跟不上）
  - 最坏情况下通道背压或丢事件

#### 5.3 不必要的内存分配

1. `String::from_utf8_lossy(&pending[..cut]).into_owned()`：
   - `from_utf8_lossy` 返回 `Cow<'_, str>`，若输入是有效 UTF-8 则无需分配。
   - `.into_owned()` **强制分配**，即使有零拷贝可能。
   - **建议**：`to_string()` 语义更清晰；或者如果 `Cow` 是 Borrowed，直接 `to_string()` 同样会分配。此点优化空间不大，除非使用 `base64` 传输二进制（但这里本来就是字符串事件）。

2. `pending.drain(..cut)`：
   - 小 Vec（最多 4 bytes + 8192 bytes）的 drain 开销可忽略。
   - 若追求极致，可用固定 ring buffer 或 offset 指针避免移动。

#### 5.4 `which()` 在非 Windows 上的缺陷（中等）

---

### 6. Tauri 最佳实践

#### 6.1 State 管理

- `AppState { pty: Arc<PtyManager> }` 作为 `tauri::Manager::manage()` 状态，**正确**。
- `PtyManager` 内部用 `Mutex` 保护，使得 `State<'_, AppState>` 可通过不可变引用调用可变操作，符合 Tauri State 的设计。

#### 6.2 事件命名

事件名使用硬编码字符串：
- `"vibe99:terminal-data"`
- `"vibe99:terminal-exit"`
- `"vibe99:menu-action"`
- `"context-menu-show"`

**建议**：定义常量模块，避免拼写错误。

#### 6.3 命令签名

所有命令都是同步函数（`#[tauri::command]` 无 `async`）。对于 PTY 操作：
- `terminal_write`、`terminal_resize` 是轻量同步操作，合理。
- `terminal_create` 内部可能阻塞在 `spawn` 系统调用、线程 join、磁盘 I/O。Tauri 的同步命令运行在**线程池**（默认 4 线程），如果 `create` 被频繁调用且 `destroy` 的 join 阻塞，可能耗尽线程池。
- **建议**：`terminal_create` 可考虑改为 `async` 命令，配合 `tokio::task::spawn_blocking` 执行重操作。

#### 6.4 窗口关闭处理

`on_window_event` 的 `CloseRequested` 处理：

```rust
if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
    let state = window.state::<AppState>();
    terminal::destroy_all_terminals(&state);
    std::process::exit(0);
}
```

---

### 7. 平台兼容性

#### 7.1 条件编译使用

| 代码 | 平台 | 评价 |
|------|------|------|
| `#[cfg(target_os = "macos")]` ProMotion/背景色 | macOS | 恰当，使用了 `macos-private-api` feature |
| `#[cfg(target_os = "windows")]` WSL | Windows | 恰当，非 Windows 平台编译为 no-op |
| `#[cfg(unix)]` / `#[cfg(not(unix))]` `is_executable` | Unix / 其他 | 恰当 |
| `#[cfg(target_os = "windows")]` / `#[cfg(not(target_os = "windows"))]` `which` | Windows / 其他 | 非 Windows 实现已完整（搜索 PATH） |

#### 7.2 Windows 路径与 Shell 检测

- Windows 候选链：`VIBE99_WINDOWS_SHELL` → `powershell.exe` → `pwsh.exe` → `cmd.exe` → `ComSpec` → `cmd.exe`（重复）→ WSL
- `ComSpec` 通常就是 `cmd.exe`，追加逻辑略有冗余，但无害。
- `which()` 在 Windows 上正确附加 `.exe` 并搜索 PATH，是完整的实现。

#### 7.3 macOS 专属代码质量

`settings.rs` 中的 Objective-C 运行时调用：

```rust
#[cfg(target_os = "macos")]
pub fn set_ns_window_bg_ptr(ptr: *mut std::ffi::c_void, is_light: bool) {
    unsafe {
        // msg_send! 大量未缓存 selector
    }
}
```

- `msg_send!` 每次调用都会重新解析 selector（虽然 objc2 有缓存，但直接使用 `sel!()` 宏更明确）。
- `setUnderPageBackgroundColor:` 被发送给所有 subview（`for i in 0..count`）。这是 WKWebView 的私有方法，NSView 默认不响应，会被忽略（返回 nil）。虽然无害，但属于 **duck typing 式运行时探测**，略脆弱。
- `configure_promotion_frame_rate` 正确使用了 `respondsToSelector:` 做运行时版本检查，**良好**。

#### 7.4 `get_system_language()` 的跨平台 bug（中等）

#### 7.5 Shell 集成脚本的路径假设（低）

`commands/shell_integration.rs`：

```rust
let home = std::env::var("HOME").map(PathBuf::from)
    .map_err(|_| "HOME environment variable not set".to_string())?;
let config_dir = home.join(".config").join("vibe99");
```

- Windows 上 `HOME` 环境变量通常不存在（应为 `USERPROFILE`）。
- `~/.config` 是 XDG 规范路径，Windows 应使用 `%APPDATA%` 或 `%LOCALAPPDATA%`。
- 当前实现实际上在 Windows 上会返回错误，阻止 shell 集成安装。但考虑到这是 bash/zsh 脚本，Windows 用户本来就不需要，**建议**明确限制为 `#[cfg(unix)]` 或兼容 Windows 路径。

#### 7.6 `shell_candidates` 的 args 问题（中等）

Unix fallback 对所有 shell 统一使用 `args: vec!["-il".into()]`：

```rust
candidates.push(ShellCandidate {
    shell: p,
    args: vec!["-il".into()],
    display_name: None,
});
```

- `-il` 是 POSIX shell（bash/zsh/sh）的选项。
- 如果 `SHELL` 指向 `fish`，`fish -il` 是有效的（fish 支持 `-i` 和 `-l`）。
- 如果 `SHELL` 指向 `nushell` (`nu`)，`nu -il` 可能不被支持（nu 使用 `-i` 但 `-l` 含义不同）。
- 这是一个**隐式假设所有 shell 都兼容 bash 风格参数**的问题。对于自动检测的 fallback，这样做是务实的，但应在文档中说明。

---

### 8. 逐文件代码问题

#### 8.1 `src-tauri/src/main.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 236-242, 300-306 | 低 | `run_on_main_thread` 的返回值被 `let _ =` 忽略。若主线程调度失败，后续 Objective-C 调用会在错误线程执行，可能崩溃 |
| 249, 256 | 低 | `emit` 返回值被忽略，事件可能未送达但调用方无从得知 |
| 309 | 低 | `.expect("error while running tauri application")` 在 release 模式下会终止进程且无用户提示（因为 `windows_subsystem = "windows"` 隐藏了控制台） |

#### 8.2 `src-tauri/src/lib.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 7-8 | 低 | `IS_LIGHT_MODE` 使用 `AtomicBool`，但 `Ordering::Relaxed` 在多核上可能导致主题切换和 resize handler 观察到短暂不一致。鉴于只是颜色切换，实际影响极小，但严格来说应使用 `SeqCst` 或至少 `Acquire/Release` |

#### 8.3 `src-tauri/src/pty.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 146 | 中等 | `spawn()` 中 `self.destroy(pane_id)` 若因线程 join 阻塞，会导致 spawn 同步命令长时间挂起 |
| 242 | 低 | `String::from_utf8_lossy(...).into_owned()` 强制分配。虽然影响有限，但高频输出场景下可累积成显著开销 |
| 275-277 | 低 | 退出线程中 `manager.sessions.lock()` 使用 `if let Ok` 忽略 poisoned lock。如果其他线程 panic 导致 lock poison，session 将永远残留在 map 中，造成内存泄漏 |
| 392-427 | 中等 | `shell_candidates()` 每次 spawn 都读取 `settings.json`。高频创建 pane 时的 I/O 热点 |
| 476-493 | 低 | `load_settings_config()` 与 `commands/settings.rs` 的 `settings_path` + `sanitize_config` 逻辑重复，维护负担 |
| 567 | 低 | Unix fallback 统一使用 `"-il"`，假设所有 shell 兼容 bash 参数风格 |
| 543-558 | 低 | Windows 候选链中 `ComSpec` 通常就是 `cmd.exe`，追加逻辑冗余 |
| 642-690 | 中等 | `build_command` 对非绝对路径 shell 调用 `which()`，但非 Windows 的 `which()` 不搜索 PATH，导致相对路径 shell profile 在 macOS/Linux 上无法解析 |

#### 8.4 `src-tauri/src/wsl.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 35-51 | 低 | `is_wsl_available()` 每次都 spawn 进程检测，可缓存结果（WSL 安装状态不会在运行时改变） |
| 123 | 低 | `windows_to_wsl_path` 是纯字符串操作，正确且高效 |

#### 8.5 `src-tauri/src/commands/settings.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 420-451 | 低 | `set_window_theme` 获取了 `window` 后，又调用 `window.app_handle()` 传给 `apply_ns_window_background`，但 `app` 参数本身已是 `AppHandle`，可直接使用 |
| 480-524 | 低 | `set_ns_window_bg_ptr` 中对所有 subview 发送 `setUnderPageBackgroundColor:`。只有 WKWebView 响应该 selector，其他 view 会静默忽略。虽然无害，但属于对内部实现细节的脆弱依赖（wry 版本升级后 subview 结构可能改变） |
| 591 | 低 | `settings_load` 中 `serde_json::from_str(&contents).unwrap_or_else(|_| sanitize_config(&Value::Null))` 静默忽略 JSON 解析错误，用户损坏的配置文件会被重置而**没有任何警告** |
| 355, 376 | 低 | `unreachable!()` 依赖前序逻辑，理论上安全但不符合 Rust 的防御性编程风格。可用 `if let Some(obj) = ... else { return default }` 替代 |

#### 8.6 `src-tauri/src/commands/shell_profile.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 228-257 | 低 | `shell_profiles_detect()` 调用 `crate::pty::auto_detected_candidates()`，该函数在 Windows 上也会尝试 `wsl.exe`，但 `friendly_label` 对 `wsl.exe` 返回 `"WSL"` 而非具体发行版名。与 `pty.rs` 中 `display_name: Some(format!("WSL ({})", distro))` 不一致 |

#### 8.7 `src-tauri/src/commands/terminal.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 119-131 | 低 | `get_cwd` 优先使用 `HOME` 环境变量。在 Windows 上 `HOME` 通常不存在，会回退到 `current_dir()`，逻辑正确但可显式处理 `USERPROFILE` 以提高可读性 |
| 137-142 | 低 | `base64_decode` 函数可改用 `base64::Engine` 的常量引用，避免每次调用时重复解析 alphabet（实际编译器会优化，可忽略） |

#### 8.8 `src-tauri/src/commands/shell_integration.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 14-16 | 中等 | 在 Windows 上 `HOME` 环境变量通常不存在，命令会直接返回错误。由于安装的是 bash/zsh 脚本，Windows 用户本就不需要，但应显式限制平台或兼容 `USERPROFILE` |
| 38-91 | 低 | 只提供了 zsh 和 bash 的集成脚本，未提供 fish、PowerShell 的支持。对于 "Agentic Coding" 场景，PowerShell 是 Windows 主力 shell，缺失支持会影响体验 |

#### 8.9 `src-tauri/src/commands/notification.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 5-6 | 低 | `send_notification` 的返回值被忽略，通知发送失败前端无法感知。由于这是 fire-and-forget 操作，当前实现可接受，但建议返回 `Result<(), String>` 让前端可选处理 |

#### 8.10 `src-tauri/src/commands/context_menu.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 46-70 | 低 | `show_context_menu` 将前端传来的所有字段原样 emit 回前端，本质上是一个透传命令。当前端和后端在同一进程内时，这种 IPC 透传有轻微性能开销，但逻辑清晰，可接受 |
| 80-93 | 低 | `emit_menu_action` 同样为透传。`pane_id` 字段命名为 `pane_id` 但接收参数也是 `pane_id`，序列化时 `skip_serializing_if = "Option::is_none"` 处理正确 |

#### 8.11 `src-tauri/src/commands/wsl.rs`

| 行号 | 严重等级 | 问题描述 |
|------|----------|----------|
| 18-35 | 低 | `wsl_status()` 每次调用都执行 `is_wsl_available()`（内部 spawn 进程）+ `list_distributions()`（又 spawn 进程）+ `detect_wsl_default_shell()`（再 spawn 进程）。共 3 次进程 spawn。虽然这是命令式调用（非高频），但可缓存或合并检测 |
| 42-45 | 低 | `wsl_convert_path` 在转换失败时返回 `Err(format!("cannot convert path: {windows_path}"))`，错误信息可被前端展示，但缺少错误分类 |

---

### 9. 综合优先级清单（剩余未修复）

#### 🔴 严重（必须修复）

（本次修复周期中已处理大部分严重项，剩余以架构债务为主。）

#### 🟡 中等（建议修复）

1. **`pty.rs:spawn()` 每次从磁盘读取 settings** → 将设置缓存到 `AppState` 或作为参数传入 `spawn()`。
2. **`pty.rs:destroy()` 中 `exit_thread.join()` 可能无限阻塞** → 文档化或引入超时机制（已改为后台 join，但子进程仍可能僵尸）。
3. **`shell_integration.rs` 在 Windows 上失败** → 限制平台或兼容 Windows 环境变量。

#### 🟢 低（可选优化）

4. 统一使用 `log` crate 替代大量 `let _ =` 静默吞错。
5. `String::from_utf8_lossy(...).into_owned()` 可评估零拷贝优化。
6. `shell_candidates` 中 `-il` 参数假设所有 shell 兼容 bash 风格。
7. `IS_LIGHT_MODE` 原子序数从 `Relaxed` 提升为 `Acquire/Release`。
8. `shell_integration.rs` 增加 PowerShell / fish 支持。
9. `wsl_status()` 合并多次 `wsl.exe` 进程调用。

---

### 10. 架构改进建议（长期）

1. **引入 SettingsStore 抽象层**
   - 封装 `settings.json` 的读、写、缓存、锁。
   - `PtyManager` 不再直接读盘，而是接收 `Arc<SettingsStore>` 或配置快照。

2. **PtyManager 使用 `DashMap`**
   - 替换 `Mutex<HashMap>` 为 `DashMap<String, PtySession>`，消除全局锁瓶颈。

3. **输出背压与节流**
   - 在读线程与 Tauri emit 之间引入 channel + 定时器，按 8-16ms 间隔批量输出。
   - ✅ 已部分实现：PTY coalescing 已降低事件频率。

4. **错误类型系统**
   - 定义 `Vibe99Error` enum，内部传递结构化错误，在 IPC 边界统一序列化为 `{ code, message }`。

5. **生命周期测试**
   - 为 `PtyManager` 增加并发测试：快速 create/destroy、destroy_all 中途 create、窗口关闭时的 race condition。

---

## 四、安全

### 1. 执行摘要

Vibe99 是一款基于 Tauri 2 (Rust) + xterm.js 的桌面终端模拟器。整体代码质量较高，输入校验和配置清洗（sanitize）做得较为到位。近期修复已大幅降低了高危风险面，但仍存在以下剩余问题。

| 风险等级 | 数量 | 关键问题 |
|---------|------|---------|
| 🟢 低 | 3 | `exit_app` 无确认、Windows `which` 当前目录劫持、通知内容未过滤 |
| 🔵 信息 | 6 | macOS 私有 API、session shortcuts 未深度校验、WSL distro 名称未校验等 |

---

### 2. 按维度详细发现

#### 2.2 路径遍历

#### V-04: WSL 路径转换未校验目标存在性

- **风险等级**：🔵 信息
- **位置**：`src-tauri/src/wsl.rs:122-157`
- **说明**：`windows_to_wsl_path` 是纯字符串转换，正确拒绝了 UNC 路径与驱动器相对路径，属于设计意图。由于不触及文件系统，不存在路径遍历漏洞。
- **修复建议**：保持当前实现；若未来需要验证 WSL 端存在性，可在 WSL 侧执行 `wslpath` 并校验返回结果。

---

#### 2.3 OSC 序列安全

#### V-07: OSC 133 D 命令 exitCode 解析未校验数值有效性

- **风险等级**：🔵 信息
- **位置**：`src/renderer.js:636`
- **说明**：`parseInt(data.slice(2), 10)` 对非数字输入（如 `D;foo`）返回 `NaN`，此时 `exitCode === 0` 为 `false`，UI 显示为失败状态，无安全后果。
- **修复建议**：显式校验 `!Number.isNaN(exitCode)` 以提高代码健壮性。

---

#### 2.5 IPC 安全

#### V-12: `exit_app` 可被前端任意调用

- **风险等级**：🟢 低
- **位置**：`src-tauri/src/commands/terminal.rs:80-84`
- **利用条件**：任何能执行前端 JS 的上下文（如 XSS）。
- **影响范围**：拒绝服务（DoS），用户未保存的工作可能丢失。
- **状态**：退出方式已改为 Tauri 受控退出 `app.exit(0)`，但仍**缺少确认对话框**。
- **修复建议**：增加确认对话框，或在调用前检查是否有正在运行的 PTY 会话，提示用户确认。

#### V-13: `send_notification` 无频率与内容过滤

- **风险等级**：🟢 低
- **位置**：`src-tauri/src/commands/notification.rs:4-6`、`src/renderer.js:714-721`
- **利用条件**：终端程序通过 OSC 133 序列或前端脚本高频触发通知。
- **影响范围**：通知垃圾邮件；通知内容若被伪造可用于社会工程学（如伪装成系统更新提示）。
- **修复建议**：增加通知频率限制（如每秒最多 1 条）和内容长度限制。

---

#### 2.6 进程安全

#### V-15: Windows `which()` 搜索当前目录

- **风险等级**：🟢 低
- **位置**：`src-tauri/src/pty.rs:737-760`
- **利用条件**：攻击者在用户当前工作目录放置与系统程序同名的恶意 `.exe`。
- **影响范围**：Vibe99 的自动检测或 `build_command` 的 PATH 解析可能优先加载当前目录下的恶意可执行文件。
- **修复建议**：Windows 下的 `which` 实现应避免搜索当前目录，或至少在搜索结果后验证文件签名/路径白名单。

#### V-16: WSL Distro 名称作为参数传递未做校验

- **风险等级**：🔵 信息
- **位置**：`src-tauri/src/wsl.rs:214-230`
- **说明**：`wsl_shell_args` 将 `distro` 直接作为 `--distribution <distro>` 的参数。虽然 `distro` 通常来自 `wsl.exe --list` 的输出，但若通过其他渠道传入（如用户配置），以 `-` 开头的 distro 名称可能被 `wsl.exe` 解析为选项。
- **修复建议**：在构造参数前校验 `distro` 不以 `-` 开头，或仅允许已检测到的 distro 名称。

---

#### 2.7 持久化安全

#### V-18: `settings_save` 保留旧 `shell` block 的潜在配置污染

- **风险等级**：🔵 信息
- **位置**：`src-tauri/src/commands/settings.rs:613-621`
- **说明**：当前端发送 partial payload（不含 `shell`）时，后端会保留磁盘上已有的 `shell` block。这是功能设计（防止 profile 被意外覆盖），但意味着攻击者若之前成功写入了恶意 `shell` 配置，后续正常的部分保存不会清除它。
- **修复建议**：该设计合理，因为恶意配置本身需要通过其他漏洞注入。建议在文档中说明此行为，并强调 `shell_profile_add/remove` 是修改 shell 配置的唯一推荐入口。

#### V-19: Session `shortcuts` / `statusBarFormat` 未做深度校验

- **风险等级**：🔵 信息
- **位置**：`src-tauri/src/commands/settings.rs:170-193`
- **说明**：`shortcuts`、`statusBarFormat`、`statusBarHints` 被原样保留。当前代码中它们仅通过 `textContent` 渲染，不存在 XSS。但若未来有模块改为 `innerHTML`，则可能引入 DOM XSS。
- **修复建议**：对 `statusBarFormat` 和 `statusBarHints` 增加字符白名单（如仅允许字母、数字、空格和少量标点），并在文档中规定这些字段**永远**不得通过 `innerHTML` 渲染。

---

### 2.8 供应链与 Tauri 安全最佳实践

#### V-21: `macos-private-api` 在生产构建中启用

- **风险等级**：🔵 信息
- **位置**：`src-tauri/Cargo.toml:20`、`src-tauri/tauri.conf.json:30`
- **说明**：macOS 私有 API 不受 Apple 兼容性保证，未来系统更新可能破坏功能；若上架 Mac App Store 会被拒绝。
- **修复建议**：评估是否所有私有 API 调用（如 `set_ns_window_bg_ptr`）都不可替代。若必须保留，在文档中声明；若仅用于视觉效果，考虑使用标准 API 替代。

---

### 3. 逐文件问题清单（剩余未修复）

#### `src-tauri/src/pty.rs`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| 737-760 | 🟢 低 | Windows `which()` 优先搜索当前目录，存在 DLL/EXE 劫持风险 |

#### `src-tauri/src/commands/terminal.rs`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| 80-84 | 🟢 低 | `exit_app` 可被前端直接调用，无确认对话框 |

#### `src-tauri/src/commands/settings.rs`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| 613-621 | 🔵 信息 | 保留旧 `shell` block 的设计需文档化 |
| 170-193 | 🔵 信息 | `shortcuts` / `statusBarFormat` 未做深度内容校验 |

#### `src-tauri/src/wsl.rs`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| 214-230 | 🔵 信息 | `wsl_shell_args` 未校验 `distro` 是否以 `-` 开头 |
| 122-157 | 🔵 信息 | `windows_to_wsl_path` 正确拒绝 UNC/驱动器相对路径，设计良好 |

#### `src/renderer.js`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| 714-721 | 🟢 低 | 通知内容未过滤，可被用于社会工程学 |

#### `src/terminal-bridge.js`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| 88-162 | 🔵 信息 | 所有 IPC 调用直接透传，无额外权限中间层（在 Tauri 模型下可接受，但需确保前端不可被注入） |

#### `src/context-menu.js`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| 30-140 | 🔵 信息 | 实现干净，使用 `textContent` 而非 `innerHTML`，无 DOM XSS |

#### `src-tauri/Cargo.toml` / `tauri.conf.json`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|
| Cargo.toml:20 | 🔵 信息 | `macos-private-api` 生产启用 |

#### `src-tauri/capabilities/default.json`

| 行号 | 风险等级 | 问题描述 |
|------|---------|---------|

---

### 4. 修复优先级与建议（剩余）

#### P2（中期改进）

1. **为 `exit_app` 增加确认对话框**（V-12）。

#### P3（长期优化/代码卫生）

2. 评估 `macos-private-api` 的必要性（V-21）。
3. 对 Windows `which()` 移除当前目录搜索（V-15）。
4. 对 WSL `distro` 名称做前缀校验（V-16）。
5. 增加通知频率与内容过滤（V-13）。

---

### 5. 结论

Vibe99 在配置清洗（sanitize）和 WSL 路径转换方面展现了良好的安全设计意识。近期修复周期已关闭多项高危安全项（剪贴板隐私、SSH 配置暴露、命令注入防护、受控退出、输入长度限制等）。当前剩余的安全隐患以中低风险为主，主要集中在 IPC 暴露面、路径遍历和输入校验方面，建议团队按照上述 P1/P2 优先级逐项修复，并在后续版本中建立安全测试基线（如 CSP 合规检查、生产构建 feature 审计）。

---

*报告结束。本合并报告已移除经代码审查确认已修复的审计项。*

---

## 五、与主流终端软件的功能差距分析

> 分析日期：2026-05-07
> 对比对象：iTerm2、Warp、Ghostty、Kitty、WezTerm、Alacritty、Windows Terminal
> 依据：代码基检视（前端 `src/`、`src-tauri/`）+ 公开产品文档与基准测试

### 1. 严重差距（直接影响核心竞争力和产品定位）

#### 1.1 原生 GPU 渲染管线缺失

**现状**：Vibe99 的渲染层完全依赖 `xterm.js` + `@xterm/addon-webgl`。从 `renderer.js:335-378` 可见，WebGL addon 加载失败时静默回退到 Canvas/DOM 渲染器，且对大输出场景无特殊优化。

**差距**：
- **Ghostty** 使用 Apple Metal 原生框架（macOS）和 OpenGL（Linux），吞吐量是 iTerm2 的 ~3 倍。
- **Alacritty/Kitty/WezTerm** 均使用原生 OpenGL 渲染管线，直接操作 GPU texture，输入延迟在 2-8ms 级别。
- **xterm.js WebGL addon** 在 JS 层管理 cell atlas 和 texture upload，面对 Agentic Coding 场景下常见的 10 万行 diff 输出时，帧率和内存占用远不及原生 GPU 终端。

**影响**：作为定位 "Agentic Coding" 的终端，大输出性能是核心体验。当前架构在长时间运行的 Agent 会话中可能出现掉帧和内存膨胀。

**建议**：中长期应评估替代渲染后端（如集成 `alacritty_terminal` crate 作为 Rust 层渲染器，或通过 Tauri 暴露原生 OpenGL 上下文）。

---

#### 1.2 AI 集成缺失（与 "Agentic Coding" 定位错位）

**现状**：Vibe99 的 PRD 将 "Agent Protocol 解析器" 列为 P2（中期布局），但当前代码基中没有任何 AI 相关功能。仅有的 "智能" 特性是 OSC 133 命令块标记和系统通知。

**差距**：
- **Warp** 的核心价值主张是 AI 原生终端：自然语言转命令、错误解释、Agent 编排（"Oz"）。
- **iTerm2** 已集成 OpenAI LLM Chat 窗口，可基于终端上下文提供建议。
- 即使不追求 Warp 级别的 AI 功能，现代终端用户至少期望**命令建议**和**错误智能提示**。

**影响**：产品名称和 PRD 强调 "Agentic Coding"，但当前功能集与传统终端无异，用户感知不到 "Agentic" 差异化。

**建议**：
1. 短期：集成轻量级本地模型（如 llama.cpp 或 Ollama）提供命令补全和错误解释。
2. 中期：实现 PRD 中的 Agent Protocol 解析器，识别 Claude Code / Aider / Codex CLI 的输出模式。

---

#### 1.3 终端协议生态落后

**现状**：从 `renderer.js` 的 addon 加载逻辑看，Vibe99 仅加载了 xterm.js 官方 addon（fit、search、web-links、webgl、image、unicode11）。图像支持依赖 `@xterm/addon-image`，该 addon 实现的是**OSC 1337（iTerm2 图像协议）**的子集。

**差距**：
| 协议 | Vibe99 | Ghostty | Kitty | WezTerm | 说明 |
|------|--------|---------|-------|---------|------|
| OSC 1337 (iTerm2 Image) | ✅ | ✅ | ❌ | ✅ | 基础图像显示 |
| Kitty Graphics Protocol | ❌ | ✅ | ✅ (原生) | ✅ | 已成为社区事实标准，`ranger`、`yazi`、`neofetch` 主流支持 |
| Sixel | ❌ | ✅ | ❌ | ✅ | 传统图像协议，部分 legacy 工具依赖 |
| Kitty Keyboard Protocol | ❌ | ✅ | ✅ (原生) | ✅ | 区分 `Ctrl+I` vs `Tab`、`Ctrl+Shift+Enter` 等模糊键位 |
| synchronized rendering | ❌ | ✅ | ✅ | ✅ | 避免全屏 TUI 应用（如 neovim）的撕裂 |
| grapheme clustering | ❌ | ✅ | ✅ | ✅ | ZWJ emoji（👨‍👩‍👧‍👦）正确渲染 |

**影响**：不支持 Kitty Graphics Protocol 意味着大量现代 CLI 工具（如使用 `ranger` 做文件管理、`yazi` 预览图像）无法在 Vibe99 中显示图像。不支持 Kitty Keyboard Protocol 导致在 neovim/emacs 中部分键位映射冲突。

**建议**：
1. 评估迁移到 `xterm.js` 7.x（如果支持 Kitty Graphics Protocol），或自行实现 Kitty 图像协议解析器。
2. 引入 `grapheme-splitter` polyfill 解决 grapheme cluster 问题。

---

### 2. 中等差距（影响 power user 采纳和日常效率）

#### 2.1 会话持久化机制不足

**现状**：`PtyManager` 的 session 生命周期与 Tauri 窗口强绑定。`main.rs` 的 `CloseRequested` 事件直接调用 `terminal::destroy_all_terminals` 并 `std::process::exit(0)`。PRD P0.3 "Session Daemon 模式" 仍是规划状态。

**差距**：
- **iTerm2** 的 Session Restoration：窗口崩溃或应用升级后，shell 仍在后台运行，重启后自动重连。
- **WezTerm** 内置 multiplexer server，支持通过 `wezterm connect` 重连远程或本地会话。
- **tmux/screen** 是业界标准的会话持久化方案，但 Vibe99 没有 tmux 集成（见 2.4）。

**影响**：Agent 任务在后台运行期间如果用户误关窗口或应用崩溃，所有进程直接终止，数据丢失风险高。

---

#### 2.2 无输出触发器（Triggers）与自动化

**现状**：代码基中没有任何对终端输出流进行正则匹配并触发动作的机制。

**差距**：
- **iTerm2 Triggers**：正则匹配输出 → 高亮文本 / 发送通知 / 自动回复 / 运行脚本 / 打开密码管理器。这是 iTerm2 power user 的核心工作流。
- **WezTerm**：Lua 事件系统允许对输出、标题变化、目录变化注册回调，实现无限定制。
- **Kitty**：kittens 系统支持用 Python 扩展终端行为。

**影响**：Agentic Coding 场景下，用户需要监控 Agent 输出中的特定模式（如 "error"、"approve?"、"done"）。没有 Triggers，用户只能依赖视觉扫描或外部工具。

**建议**：在前端 `renderer.js` 的 PTY 数据流中增加可配置的 trigger 管道，匹配正则后触发通知、自动输入确认、或高亮渲染。

---

#### 2.3 Scrollback 搜索局限

**现状**：Vibe99 的搜索依赖 `@xterm/addon-search`，从 `renderer.js` 可见搜索栏仅操作当前 xterm viewport。PRD P1.2 "正则搜索 + 跨 pane 搜索" 仍处于规划。

**差距**：
- **Ghostty 1.3**：scrollback search 使用独立搜索线程，可搜索完整 scrollback 历史（默认 2500 万行），且在 4GB asciinema 文件上秒级响应。
- **iTerm2/Kitty/WezTerm**：均支持全历史搜索，且支持正则表达式。
- **Vibe99**：addon-search 仅搜索当前屏幕可见内容，对于已滚出 viewport 的历史输出无法检索。

**影响**：Agent 输出大量日志后，用户无法找回之前滚出屏幕的关键信息。

**建议**：将搜索索引从 xterm.js 内部剥离，在 Rust 层用 `regex` crate 建立文本索引（如 PRD 所规划），或至少实现基于前端缓冲区的全历史搜索。

---

#### 2.4 无多路复用器（tmux）集成

**现状**：Vibe99 实现了基础的分屏和标签，但没有与 tmux 的集成。

**差距**：
- **iTerm2**：`tmux -CC` 原生集成，tmux 窗口映射为 iTerm2 原生窗口/标签，无需记忆 prefix key。
- **WezTerm**：内置 multiplexer，功能足以替代 tmux，且支持通过 SSH 远程复用。
- **Kitty**：内置 tiling 和远程控制协议，减少对 tmux 的依赖。

**影响**：对于已有深厚 tmux 工作流的用户，Vibe99 的分屏无法替代 tmux 的会话持久化、远程 attach、结对编程等能力，导致这部分用户没有迁移动力。

---

#### 2.5 无全局热键 / Quake 模式

**现状**：代码中没有任何系统级全局热键注册逻辑。Dock 菜单支持新建窗口，但无法通过热键召唤。

**差距**：
- **iTerm2 Hotkey Window**：系统级热键召唤下拉终端，即使全屏应用也可见。
- **Ghostty Quick Terminal**：`global:ctrl+backtick` 召唤轻量终端，动画滑入菜单栏下方。
- **Windows Terminal / Guake / Yakuake**：均有 Quake-style 下拉模式。

**影响**：Agentic Coding 工作流要求终端随时可达。没有全局热键，用户必须切换应用再找到 Vibe99 窗口，打断心流。

**建议**：利用 Tauri 2 的 `global-shortcut` API（或 macOS 私有 API）实现可配置的 Quake 模式窗口。

---

#### 2.6 无 Copy Mode（键盘驱动选择）

**现状**：Vibe99 的文本选择完全依赖鼠标。`renderer.js` 中只有鼠标拖拽选择逻辑，没有键盘导航的复制模式。

**差距**：
- **iTerm2 / Ghostty / Kitty**：均提供 Vim-like Copy Mode（`Ctrl+[` 或等效键进入，用 `h/j/k/l` 导航，空格选择，y 复制）。
- 这是无鼠标工作流（keyboard-driven workflow）的标配。

**影响**：Power user 和 Vim 用户期望全程键盘操作，当前必须伸手去鼠标才能复制文本。

---

#### 2.7 智能选择与语义操作缺失

**现状**：Vibe99 的双击选择由 xterm.js 内置逻辑处理，只能选择单词。右键菜单（`context-menu.js`）提供基础操作，但没有基于语义的智能识别。

**差距**：
- **iTerm2 Smart Selection**：四击自动识别 URL、文件路径、邮箱、引号字符串等语义对象。
- **Ghostty**：三指轻点 / Force Touch 调用 macOS Quick Look。
- **Kitty**：`Ctrl+Shift+Right-click` 打开 `ls` 输出中的文件。

**影响**：在终端中处理 URL、文件路径时，用户需要手动精确选择，效率低下且易出错。

---

### 3. 低优先级差距（有机会时补充）

#### 3.1 连字（Ligatures）渲染

**现状**：PRD P1.4 已规划，但代码中未见实现。`styles.css` 中没有 `font-variant-ligatures` 相关规则。

**差距**：Ghostty/Kitty/WezTerm/Alacritty 均已原生支持 Fira Code、JetBrains Mono 等字体的编程连字（`!=` → `≠`、`=>` → `⇒`）。

---

#### 3.2 粘贴保护

**现状**：`renderer.js` 的粘贴逻辑（`isWindowsCtrlVPasteHotkey` 等）直接透传文本，没有多行命令检测或警告。

**差距**：Ghostty 1.3 引入 `clipboard-paste-protection`，粘贴多行或包含控制字符的文本时弹出警告，防止 "粘贴劫持"（pastejacking）攻击。

---

#### 3.3 安全键盘输入

**现状**：无相关实现。

**差距**：Ghostty/iTerm2 在检测到密码提示或手动启用时，会阻止其他进程监听键盘事件，并显示锁图标提示。

---

#### 3.4 窗口排列与状态保存

**现状**：Vibe99 支持 session restore（pane 布局、目录、profile），但不支持**多窗口排列**的快照保存（Window Arrangements）。

**差距**：iTerm2 可保存整个窗口布局快照并在启动时自动恢复。Ghostty 支持 `window-save-state = always`。

---

#### 3.5 行级时间戳

**现状**：无相关实现。

**差距**：iTerm2 可开启 `View > Show Timestamps`，在每行左侧显示最后修改时间，便于判断操作耗时。

---

#### 3.6 密码管理器集成

**现状**：无相关实现。

**差距**：iTerm2 内置 Password Manager，与 macOS Keychain 集成，可在终端安全地自动填充密码。

---

#### 3.7 可编程配置

**现状**：Vibe99 使用 GUI 设置面板 + JSON 持久化（`settings-ui.js`、`commands/settings.rs`）。配置是声明式的，无编程能力。

**差距**：WezTerm 的 Lua 配置允许动态条件、事件钩子、自定义状态栏。Kitty 的配置文件支持包含、宏和条件。

**注意**：这属于产品设计选择而非缺陷。GUI 配置对普通用户更友好，但会流失追求极致定制的 power user。

---

#### 3.8 原生 UI 体验差距

**现状**：Vibe99 基于 Tauri 2 + WKWebView（macOS）/ WebView2（Windows）。所有 UI（tabs、pane、status bar）均为 Web 技术渲染。

**差距**：
- **Ghostty**：macOS 上使用 AppKit + SwiftUI 原生组件，Linux 上使用 GTK。字体渲染、动画曲线、可访问性均遵循平台原生规范。
- **iTerm2**：完全原生 Cocoa 应用。
- WebView 方案在以下方面存在固有差距：
  1. **字体渲染**：WKWebView 的 CoreText 字体渲染与原生 AppKit 存在微妙差异（尤其 hinting、subpixel 抗锯齿）。
  2. **可访问性**：Web 内容的 VoiceOver 支持不如原生 NSView 完善。
  3. **电池/能耗**：WebView 的 JS 引擎和合成器功耗高于原生 Metal/OpenGL 应用。
  4. **输入延迟**：WebView 的键盘事件需经过 WebKit 内核分发，比原生 NSResponder 链多一层延迟。

---

### 4. 差距汇总矩阵

| 能力领域 | Vibe99 | iTerm2 | Warp | Ghostty | Kitty | WezTerm | 优先级 |
|---------|--------|--------|------|---------|-------|---------|--------|
| 原生 GPU 渲染 | ❌ (WebGL) | ⚠️ (Metal, 非极致) | ✅ (GPU) | ✅ (Metal/OpenGL) | ✅ (OpenGL) | ✅ (OpenGL) | 🔴 高 |
| AI 命令建议/解释 | ❌ | ✅ (LLM Chat) | ✅ (核心) | ❌ | ❌ | ❌ | 🔴 高 |
| Kitty Graphics Protocol | ❌ | ❌ | ❌ | ✅ | ✅ (原生) | ✅ | 🔴 高 |
| 会话持久化/Daemon | ❌ (规划中) | ✅ | ❌ | ❌ | ❌ | ✅ | 🟡 中 |
| 输出 Triggers | ❌ | ✅ | ❌ | ❌ | ⚠️ (kittens) | ✅ (Lua) | 🟡 中 |
| 全历史 Scrollback 搜索 | ❌ (仅 viewport) | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 中 |
| tmux 集成 | ❌ | ✅ (-CC) | ❌ | ❌ | ⚠️ | ⚠️ | 🟡 中 |
| 全局热键/Quake 模式 | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | 🟡 中 |
| Copy Mode | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | 🟡 中 |
| 智能语义选择 | ❌ | ✅ | ❌ | ✅ (Quick Look) | ✅ | ❌ | 🟡 中 |
| 编程连字 | ❌ (规划中) | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 低 |
| 粘贴保护 | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | 🟢 低 |
| 安全键盘输入 | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | 🟢 低 |
| 窗口排列快照 | ⚠️ (session only) | ✅ | ❌ | ✅ | ❌ | ✅ | 🟢 低 |
| 行级时间戳 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | 🟢 低 |
| 密码管理器 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | 🟢 低 |
| 可编程配置 | ❌ (JSON/GUI) | ❌ (GUI) | ❌ | ❌ (KV) | ⚠️ | ✅ (Lua) | 🟢 低 |
| 原生 UI 渲染 | ❌ (WebView) | ✅ | ❌ (自定义) | ✅ | ❌ (OpenGL) | ❌ (OpenGL) | 🟢 低 |

> 注：表格中的 ❌ 表示当前版本不具备该能力；⚠️ 表示部分支持或依赖外部工具；✅ 表示原生支持。

---

### 5. 战略建议

基于上述差距分析，对 Vibe99 的后续发展提出以下建议：

1. **守住基本盘，补齐性能短板**：当前基于 xterm.js 的架构在 Agentic Coding 的大输出场景下是瓶颈。建议优先评估 Rust 层原生渲染方案（如 `alacritty_terminal`），或在 Tauri 中暴露原生 GPU 上下文。

2. **落实 "Agentic" 定位，尽快落地 AI 功能**：PRD 中的 Agent Protocol 解析器（P2.1）应提升优先级。即使是轻量级的本地模型集成（命令建议 + 错误解释），也能让产品名与功能对齐，形成差异化。

3. **拥抱 Kitty 协议生态**：Kitty Graphics Protocol 和 Keyboard Protocol 已成为现代 CLI 工具链的事实标准。不支持这些协议会让 Vibe99 被排除在 neovim/ranger/yazi 等生态之外。

4. **Session Daemon 是护城河**：关闭窗口不丢会话是 Agentic Coding 的刚需（Agent 可能在后台跑数小时）。P0.3 的 Session Daemon 应尽早启动架构设计。

5. **Triggers 是自动化的入口**：Agent 输出监控（"Approve this?" / "Error occurred"）需要输出触发器。这是连接 "终端" 与 "Agentic" 的关键桥梁，建议与 P0.1 的 Block-level Shell Integration 同步设计。

---

*本章节基于代码基检视与公开产品资料编制，旨在为产品路线图提供外部竞争视角参考。*
