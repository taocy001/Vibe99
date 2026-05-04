# PRD: Vibe99 — Agentic Coding Terminal

## Goal

将 Vibe99 从"通用终端模拟器"进化为**真正的 Agentic Coding 终端**。核心方向：命令块管理、Agent 状态感知、会话保活、任务通知。

## Background

Vibe99 v0.7.2，基于 Tauri 2 + xterm.js，已完成 Electron 迁移，具备完整的终端工作区能力（Tab、分屏、布局引擎、CJK IME、快捷键、Shell Profile、广播输入等）。下一阶段目标是将"Agentic Coding"的定位落实为具体功能。

---

## P0 — 立即投入（影响核心定位）

### P0.1 Block-level Shell Integration

利用现有 OSC 133 支持，将终端输出切分为"命令 → 输出"块。

**目标能力：**
- 每条命令对应一个视觉块，块头显示命令文本和退出状态（✓ / ✗）
- 块级复制（复制整段输出而非手选）
- 块级折叠（长输出可折叠，保留命令行可见）
- 块级状态标记，为 Agent Protocol 解析器（P2.1）提供基础

**预估工作量：** 2–3 周

---

### P0.2 系统通知集成

集成 `tauri-plugin-notification`，让 Agent 任务完成可推送至系统通知中心。

**目标能力：**
- 可配置触发条件：命令块结束（成功/失败）、特定文本匹配、pane 静默超时
- 通知点击跳转至对应 pane
- 设置中可开关、配置触发规则

**预估工作量：** 2–3 天

---

### P0.3 Session Daemon 模式

将 `PtyManager` 拆分为独立守护进程，支持关闭窗口后进程保活、重开应用后重连。

**目标能力：**
- `vibe99 --attach` 重连已有会话
- 关闭主窗口不杀死 PTY 进程（Agent 任务继续跑）
- 会话列表：列出所有存活会话，支持接管/终止

**架构变更：** `Client-Server` 模型，`PtyManager` 迁移为 Unix socket daemon；前端通过 IPC 与 daemon 通信。

**预估工作量：** 4–6 周

---

## P1 — 短期跟进（提升竞争力）

### P1.1 多窗口支持

使用 Tauri 2 的 `WindowBuilder` 实现独立终端窗口，支持多显示器布局。

**目标能力：**
- 新建独立窗口（快捷键 / 菜单）
- 窗口间 pane 拖拽或复制
- 每个窗口独立布局，会话共享同一 daemon（依赖 P0.3）

**预估工作量：** 1–2 周

---

### P1.2 正则搜索 + 跨 pane 搜索

**目标能力：**
- 搜索框支持正则表达式模式切换
- 跨所有 pane/tab 的 scrollback 联合搜索，结果列表跳转

**实现路径：** 将搜索索引从 xterm.js 内部剥离，在 Rust 层用 `regex` crate 建立文本索引。

**预估工作量：** 1–2 周

---

### P1.3 SSH Profile 与连接管理

**目标能力：**
- Shell Profile 新增 "SSH" 类型：保存主机、端口、用户、密钥路径
- 连接管理 UI：列出已配置的 SSH 目标，一键打开新 pane
- 基础断线检测与重连提示

**实现路径：** Rust 层集成 `russh`，前端复用现有 Shell Profile UI 框架。

**预估工作量：** 3–4 周

---

### P1.4 连字与 Nerd Font Fallback

**目标能力：**
- CSS `font-variant-ligatures: contextual` 启用连字（Fira Code、JetBrains Mono 等）
- 内置 Powerline/Nerd Font 符号 fallback 字体，确保 starship / eza / bat 显示正常

**预估工作量：** 3–5 天

---

## P2 — 中期布局（构建差异化护城河）

### P2.1 Agent Protocol 解析器

识别 Claude Code / Aider / Codex CLI 的进度输出，提供结构化状态面板。

**目标能力：**
- 侧边或顶部 Agent 状态栏：哪个 pane 正在运行 / 等待输入 / 报错
- 检测 Agent 的危险命令请求（如 `rm -rf`），弹出 Approve/Deny 确认
- 依赖 P0.1 的命令块作为解析单元

**预估工作量：** 4–6 周

---

### P2.2 插件 / 扩展 API

通过 Tauri IPC 暴露事件总线，允许外部进程订阅终端事件、注入命令。

**目标能力：**
- WebSocket / Unix socket 接口：subscribe to terminal output, inject input, listen to block events
- 文档化 API，支持第三方脚本和 IDE 插件集成

**预估工作量：** 2–3 周

---

### P2.3 Grapheme Cluster 支持

跟随 xterm.js 7.x 升级，或引入 `grapheme-splitter` polyfill。

**目标能力：**
- ZWJ emoji（👨‍👩‍👧‍👦）列宽计算正确
- 现有 CJK 宽度逻辑保持不变

**预估工作量：** 1–2 周（主要是升级测试）

---

## 延期 / 低优先级

| 项目 | 理由 |
|------|------|
| 原生 GPU 渲染（集成 alacritty_terminal） | 与现有架构冲突过大，ROI 低 |
| RTL 双向文本 | 目标用户群体不涵盖 |
| Sixel 图像协议 | 开发工作流价值有限 |
| Mosh 支持 | Tauri 网络权限模型受限，暂缓 |
| 配置文件 TOML/YAML 格式 | 现有 JSON 已够用，优先级低 |
| `.itermcolors` 主题导入 | 可社区贡献，非核心 |
