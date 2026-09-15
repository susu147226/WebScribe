# WebScribe

轻量级网页文档抓取、整理与 Markdown / PDF 转存工具。

输入网页 URL，抓取正文，整理为干净的 Markdown，可选同时生成 PDF。
运行于 Windows 桌面，本地处理，不依赖任何云端服务。

- 作者：云舒眠眠
- 仓库：<git@github.com:susu147226/WebScribe.git>
- 许可证：**本项目不适用 MIT License**（详见文末「许可证说明」）

---

## 架构

```
                    ┌──────────────────────────────┐
                    │   React 19 + TypeScript UI   │
                    │   任务表单 / 状态表格 / 进度  │
                    └───────────────┬──────────────┘
                                    │ Tauri invoke + event
                    ┌───────────────▼──────────────┐
                    │      Tauri 2 主进程 (Rust)    │
                    │  URL 校验/去重/注册域识别     │
                    │  任务编排 · 文件落盘 · 日志   │
                    └───────────────┬──────────────┘
                                    │ NDJSON over stdin/stdout
                    ┌───────────────▼──────────────┐
                    │    crawler sidecar (Node.js)  │
                    │                              │
                    │  HTTP First ─────┐           │
                    │      │           │           │
                    │   正文不足？      │           │
                    │      │是         │否         │
                    │      ▼           ▼           │
                    │  Playwright   Readability    │
                    │  渲染          正文提取       │
                    │      └─────┬─────┘           │
                    │            ▼                 │
                    │        Turndown → Markdown   │
                    │            ▼                 │
                    │     Chromium printToPDF      │
                    └──────────────────────────────┘
```

**职责划分**

| 层 | 负责 | 不负责 |
|---|---|---|
| React | 表单、任务表格、状态与错误展示、进度 | 抓取与文件 IO |
| Rust | 任务编排、URL 校验/去重、注册域识别、**文件 IO**、sidecar 管理、日志脱敏 | 正文提取、格式转换 |
| Node (crawler) | HTTP 抓取、Playwright 渲染、正文提取、Markdown/PDF 生成、防护检测、robots.txt、退避调度 | 决定保存路径、写用户文件 |

文件 IO 收敛在 Rust 侧，便于利用 Tauri 的权限管控；crawler 通过 IPC 回传内容，由 Rust 落盘。

---

## 仓库结构

```
WebScribe/
├── src/                     React 前端
│   ├── components/          URL 面板、任务表格、状态徽章
│   ├── services/            Tauri invoke 与事件订阅封装
│   ├── stores/              任务状态（Zustand）
│   └── types/               与 Rust 共享的类型定义
├── src-tauri/               Tauri 2 主进程（Rust）
│   ├── src/
│   │   ├── protocol.rs      IPC 消息类型（与 crawler/src/protocol.ts 对应）
│   │   ├── sidecar.rs       Node 进程生命周期与 NDJSON 通信
│   │   ├── commands.rs      Tauri 命令、任务状态机、事件处理
│   │   ├── task.rs          分页结果归集、文档组装、图片搬运
│   │   ├── url.rs           校验 / 规范化 / 去重
│   │   ├── domain.rs        注册域识别（PSL）
│   │   ├── naming.rs        Windows 文件名净化
│   │   ├── document.rs      Markdown 文档结构
│   │   ├── save.rs          文件落盘
│   │   ├── logging.rs       结构化日志与凭据脱敏
│   │   └── error.rs         15 种错误类型
│   ├── capabilities/        权限配置
│   ├── icons/               应用图标
│   └── tauri.conf.json
├── crawler/                 抓取 sidecar（Node.js + TypeScript）
│   └── src/
│       ├── http/            HTTP First 抓取
│       ├── browser/         Playwright 会话与登录
│       ├── extractor/       Readability 正文提取
│       ├── markdown/        Turndown 转换与图片处理
│       ├── pdf/             Markdown → HTML → PDF
│       ├── domain/          robots.txt、防护检测
│       ├── task/            调度、退避、多页发现
│       ├── auth.ts          登录态 Cookie 读取与匹配
│       ├── errors.ts        错误归一
│       └── index.ts         NDJSON IPC 入口
├── tests/
│   ├── unit/                前端单元测试
│   └── integration/         端到端测试与 fixture 服务器
├── scripts/                 构建脚本（PowerShell）
├── runtime/                 Node 与 Chromium（不入 Git，脚本生成）
└── docs/
```

---

## 功能

- 一次任务最多 **10 个 URL**，超出会明确提示而非静默截断
- URL 合法性校验、规范化、同任务内查重
- 按**注册域（eTLD+1）**识别同站，`example.com` 与 `docs.example.com` 视为同一站点
- **HTTP First**：普通页面走轻量 HTTP 请求，不启动浏览器
- 动态页面（SPA、JS 渲染、登录后内容）自动回退到 Playwright
- 正文提取（Mozilla Readability），去除导航、广告等无关区域
- Markdown 输出，保留 H1–H6、段落、粗体、斜体、链接、图片、有序/无序列表、表格、引用、行内代码、代码块
- 可选 PDF 输出，保留中文、表格、代码与图片
- 图片可保留远程链接，或下载到同名 `.assets` 目录
- 同站长文多页自动接续为单份文档，也可选择每页独立输出
- 用户主动登录后保存登录态，后续抓取自动复用
- 极简架构：无数据库、无云端、无账号体系

---

## 开发环境

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.x | 前端构建与 crawler 开发 |
| Rust | 1.98+ | Tauri 主进程 |
| MSVC 生成工具 | VS 2022 Build Tools | Rust 在 Windows 上的链接器 |
| NSIS | 3.x | 生成安装包（Tauri 亦可自动下载） |
| WebView2 Runtime | Windows 11 已内置 | 桌面界面运行时 |

安装 Rust 工具链（国内网络建议配置镜像）：

```bash
rustup default stable-x86_64-pc-windows-msvc
```

首次运行请确认 `rustc --print host-tuple` 输出 `x86_64-pc-windows-msvc`。

---

## 构建与测试

```bash
npm install
npm run crawler:install
```

获取随包运行时（Node 与 Chromium，约 890 MB）：

```bash
powershell -ExecutionPolicy Bypass -File scripts/fetch-runtime.ps1
```

开发模式：

```bash
npm run tauri dev
```

运行测试：

```bash
npm run test:all
```

该命令依次执行前端单元测试、crawler 端到端测试与 Rust 单元测试。

单独运行：

```bash
npm run test
npm run test:integration
npm run crawler:test
cargo test --manifest-path src-tauri/Cargo.toml
```

打包：

```bash
powershell -ExecutionPolicy Bypass -File scripts/build-app.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1
```

---

## 安装版

产物：`WebScribe-Setup-x64.exe`

1. 运行安装程序
2. 按向导完成安装（默认安装到当前用户目录，无需管理员权限）
3. 从开始菜单启动 WebScribe
4. 卸载通过「设置 → 应用」或安装目录下的卸载程序完成

安装后**无需**安装 Node.js、Rust、Python、Git 或任何开发环境——运行时已随包分发。

---

## Portable 绿色版

产物：`WebScribe-Portable-x64.zip`

```
解压 → 双击 WebScribe.exe → 直接使用
```

解压后的目录结构：

```
WebScribe\
├── WebScribe.exe
├── runtime\
│   ├── node\             Node 运行时
│   └── browsers\         Chromium（渲染与 PDF）
├── crawler\              抓取模块
└── resources\
```

Portable 版不写注册表、不在系统目录留下文件。登录态与临时数据保存在
`%LOCALAPPDATA%\com.webscribe.app\` 下，删除该目录即可完全清除用户数据。

---

## 使用方式

1. 在左侧「网页 URL」框中填入地址，**一行一个**，最多 10 个
2. 选择输出格式：Markdown（默认）/ PDF / Markdown + PDF
3. 选择图片处理方式：保留远程链接，或下载到本地
4. 按需开启「自动续页」（默认关闭，上限 5 页）与「每页独立输出」
5. 点击「选择」指定保存位置
6. 点击「开始抓取」

任务表格实时显示每个 URL 的状态、当前步骤、进度与输出文件路径。
错误会明确展示，不会把失败伪装成成功。

---

## 登录态说明

部分内容需要登录后才能访问。WebScribe 的处理流程是：

```
点击「打开浏览器登录」
       ↓
打开一个有头浏览器窗口
       ↓
您自行输入账号 → 自行输入密码 → 自行完成验证码 → 自行完成二次验证
       ↓
关闭窗口 → 保存登录态 → 后续抓取自动复用
```

程序**不会**读取、记录或上传您的明文密码，也**不会**破解验证码、绕过 MFA
或任何网站登录限制。登录态仅保存在本机。

保存位置：`%LOCALAPPDATA%\com.webscribe.app\auth\<注册域>.json`

该目录已在 `.gitignore` 中排除，不会进入版本库。

---

## 安全说明

### 抓取行为

- **频率**：同站串行 + 跨站并行（上限 3）；同一站点两次请求间隔至少 1 秒
- **重试**：有限重试（上限 3 次），采用指数退避
- **多页发现**：默认关闭，开启后上限 5 页，受同站范围限制与 URL 去重约束；无法可靠判断下一页时停止并提示，不做猜测

### robots.txt

默认严格遵循目标站点的 robots.txt。**您手动填写的 URL 始终可抓取**——
这是您明确表达的抓取意图；该设置约束的是程序自动续页发现的页面。

### 网站防御机制

遇到验证码、Cloudflare Challenge、403 访问拒绝等情况时，程序会：

```
停止自动抓取 → 向用户显示原因 → 等待用户处理
```

**不会**尝试任何形式的绕过。明确不实现：CAPTCHA 破解、Cloudflare Challenge
绕过、WAF 绕过、IP 封禁绕过、频率限制绕过、浏览器指纹伪装、代理池、IP 池、
MFA 绕过、访问控制绕过。

程序在 HTTP 请求中如实标识自身（`WebScribe/0.1`），不伪装成浏览器。

### 凭据处理

日志系统按白名单记录字段（时间、URL、任务 ID、阶段、耗时、状态、错误类型），
并对以下内容做脱敏：

- URL 查询串中的敏感参数（token、api_key、password、session 等）
- 请求头中的 Authorization / Cookie / Set-Cookie 整行
- 文本中的 `key=value` 形式凭据

密码、Cookie、Token、Authorization Header、Session ID 均不会写入日志。

### 版本库卫生

`.auth/`、`.storage/`、`.sessions/`、`*.state.json` 等认证相关路径
已全部加入 `.gitignore`。

---

## 与文档的技术栈差异

以下条目偏离了 `WebScribe_CLAUDE_PROJECT_SPEC.pdf` 的原始要求，均经作者确认。

| 项 | 文档要求 | 实际 | 原因 |
|---|---|---|---|
| 爬取架构 | §9.2 核心语言为 Rust | Rust 编排 + Node sidecar 爬取 | 经作者确认选用。目的是使用 §12/§13 点名的 `@mozilla/readability` 与 `turndown` 官方实现，而非其 Rust 移植版 |
| 轻量化 | §8 减少常驻进程与依赖 | Portable 捆绑 Node 运行时（约 +90 MB） | 上述 sidecar 方案的必然代价 |
| 浏览器运行时 | §11 需先确认分发方式 | 随 Portable ZIP 提供（约 +700 MB） | 经作者确认，以保证完全离线可用 |
| 跨站并发 | §42 需先确认并发策略 | 同站串行 + 跨站并行（上限 3） | 经作者确认 |
| sidecar 打包 | Tauri 官方指南推荐 `@yao-pkg/pkg` | 捆绑 `node.exe` + 明文 JS 文件 | pkg 的虚拟文件系统与 Playwright 的 `child_process` 驱动分叉存在已知冲突。Playwright 是 §10/§41/§58 的硬性要求，不宜为其牺牲 |
| 正文首标题 | §33 文档结构 | 删除与文档标题重复的正文首标题 | Readability 会把正文 `h1` 映射为 `h2`，与本工具已在 `# 页面标题` 渲染的标题重复且层级失真。经作者确认按「还原原始层级并去重」处理 |
| 许可证 | §4 不适用 MIT | 不创建 LICENSE 文件 | 作者尚未指定正式许可证，§4 禁止自行声明 |
| 历史任务 / 缓存 / 数据库 | §43/§44 未确认 | 均不实现 | 经作者确认 |
| 保存位置 | §31 需先确认实现方式 | Tauri 原生文件夹选择器 | 经作者确认，为 §31 列出的首选方案 |
| 图片保存策略 | §34 需先确认 | 两种同时支持，由 UI 开关控制 | 经作者确认 |

### 环境相关的实施记录

| 项 | 情况 | 处理 |
|---|---|---|
| Rust 工具链下载 | 官方源实测约 224 B/s，不可用 | 经作者确认改用清华 TUNA 镜像 |
| crates 依赖拉取 | 官方源实测约 5 KB/s 且稀疏索引不可达；清华只镜像索引 | 经作者确认改用 rsproxy.cn（实测约 131 KB/s），配置位于 `~/.cargo/config.toml`，不进入仓库 |
| Playwright 浏览器下载 | 其内置下载器（基于 Node `https` 模块）在本机持续连接超时，而同地址用系统 HTTP 客户端可达 23 MB/s | `scripts/fetch-runtime.ps1` 先尝试官方安装器，失败则自动回退到手动下载解压，并写入 `INSTALLATION_COMPLETE` 标记 |
| NSIS 运行时下载 | Tauri 打包时需从 GitHub Releases 取 `nsis-3.11.zip` 与 `nsis_tauri_utils.dll`，本机实测该域名直接超时 | `scripts/fetch-nsis.ps1` 经 GitHub 加速镜像下载并校验 SHA-1 后，按 Tauri 期望的布局预置到 `%LOCALAPPDATA%\tauri\NSIS`；`build-app.ps1` 会在缺失时自动调用 |
| PowerShell 脚本编码 | Windows PowerShell 5.1 按 GBK 读取 UTF-8 脚本，导致中文乱码与语法错误 | `scripts/*.ps1` 均带 UTF-8 BOM |

> 若您的网络可正常访问上述官方源，`fetch-runtime.ps1` 与 `fetch-nsis.ps1` 会自动走官方地址，
> 无需任何额外配置；上述处理只在前者失败时生效。

---

## 许可证说明

**本项目不适用 MIT License。**

作者尚未指定正式许可证。在作者明确指定之前：

- 仓库中不包含 LICENSE 文件
- 不在 `package.json`、`Cargo.toml` 或其他项目元数据中声明任何开源许可证
- 不从模板项目或依赖项目推断本项目的许可证

如需创建正式 LICENSE 文件，请先由作者指定采用的许可证类型。

---

## 许可与致谢

本项目使用了以下开源组件，它们各自遵循其原有许可证：

- [Tauri](https://tauri.app/) — MIT / Apache-2.0
- [React](https://react.dev/) — MIT
- [Mozilla Readability](https://github.com/mozilla/readability) — Apache-2.0
- [Turndown](https://github.com/mixmark-io/turndown) — MIT
- [Playwright](https://playwright.dev/) — Apache-2.0
- [jsdom](https://github.com/jsdom/jsdom) — MIT
- [robots-parser](https://github.com/samclarke/robots-parser) — MIT
- [marked](https://github.com/markedjs/marked) — MIT
