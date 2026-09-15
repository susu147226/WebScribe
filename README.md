# WebScribe

轻量级网页文档抓取、整理与 Markdown / PDF 转存工具。

输入一个或多个网页链接，抓取正文，整理为干净的 Markdown，可选同时生成 PDF。
运行于 Windows 桌面，全部处理在本机完成，不依赖任何云端服务。

- 作者：云舒眠眠
- 仓库：<https://github.com/susu147226/WebScribe>
- 许可证：**自定义专有许可证，非开源**（详见 [LICENSE](LICENSE)）

---

## 架构

```
                    ┌──────────────────────────────┐
                    │   React 19 + TypeScript UI   │
                    │  链接列表 / 任务表格 / 进度   │
                    └───────────────┬──────────────┘
                                    │ Tauri invoke + event
                    ┌───────────────▼──────────────┐
                    │      Tauri 2 主进程 (Rust)    │
                    │  链接校验 · 文档分组 · 任务编排│
                    │  文件落盘 · 合并记录 · 日志   │
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
| React | 界面、链接列表与逐条校验展示、进度 | 抓取与文件读写 |
| Rust | 链接校验、文档分组、任务编排、**文件读写**、合并记录、日志 | 正文提取、格式转换 |
| Node (crawler) | HTTP 抓取、Playwright 渲染、正文提取、Markdown / PDF 生成、防护检测、robots.txt、退避调度 | 决定保存路径、写用户文件 |

文件读写集中在 Rust 侧，便于利用 Tauri 的权限管控；crawler 通过 IPC 回传内容，由 Rust 落盘。

**Rust 与 crawler 之间**使用长驻进程 + NDJSON（每行一个 JSON 对象）通信，协议定义分别位于
`src-tauri/src/protocol.rs` 与 `crawler/src/protocol.ts`，两边需同步修改。

---

## 功能

**链接输入**

- 粘贴区支持一次粘贴多个链接，自动拆分为独立条目
- **一行里挤了多个链接也会被正确拆开**，不会连成一个畸形地址
- 每条链接独占一行，横向滚动显示完整地址，悬停可看全文
- 逐条实时校验：格式错误、尚未填写、与第几条重复，就地以徽章标出（悬停看原因）
- **按文档分组合并展示**：同属一份文档的链接收在一个可折叠的分组里，
  组头显示分组名与条数；**有问题的组自动置顶并展开**，100 条里排查几条错误
  不必靠滚动去找
- 提供「只看问题」筛选
- 链接数量上限可选 **10 / 50 / 100** 档，并按同一站点最多的条数估算最短耗时

**界面布局**

左侧面板分三段：顶部固定（粘贴与计数）、中部列表独立滚动、**底部操作栏常驻**。
输出格式、图片处理、抓取设置收进「设置」弹窗。因此链接再多，「开始抓取」
按钮也不会被卷出视野。

**抓取**

- 一次任务最多 **10 个链接**，超出时明确提示，不静默截断
- 链接合法性校验、规范化、同任务内查重
- 按**注册域**识别同站，`example.com` 与 `docs.example.com` 视为同一站点
- **HTTP First**：普通页面走轻量 HTTP 请求，不启动浏览器
- 动态页面（SPA、JS 渲染、登录后内容）自动回退到 Playwright
- 正文提取（Mozilla Readability），自动去除导航、侧边栏、页脚
- 同站串行 + 跨站并行（上限 3），同站请求间隔至少 1 秒

**输出**

- Markdown 保留 H1–H6、段落、粗体、斜体、链接、图片、有序/无序列表、表格、引用、行内代码、代码块
- **表头行用 `<td>` 的表格也能正确转为 Markdown 表格**（不少文档站这么写）
- **代码块不会被丢弃**：装饰性容器包裹、`pre > ol > li` 逐行、highlight.js 着色等写法都能还原为围栏代码块
- 可选 PDF 输出，保留中文、表格、代码与图片
- 图片可保留远程链接，或下载到同名 `.assets` 目录实现离线存档
- 同站长文自动续页（默认关闭，上限 5 页）

**文档合并**

- 同一目录下的多个链接视为同一套文档的不同章节，**合并为一份文档**
- 判定规则：同主机 + 路径去掉最后一段后相同。例如

  ```
  https://example.com/docs/a/chapter-1
  https://example.com/docs/a/chapter-2   ── 合并为一份文档
  https://example.com/docs/a/chapter-3
  ```

- **跨任务追加**：下次抓取相似链接时，若上次的文档仍在，新内容会**追加到该文件末尾**，而不是另建一份
- 可在界面上关闭合并，或一键清除合并记录

---

## 仓库结构

```
WebScribe/
├── src/                     React 前端
│   ├── components/          链接面板、任务表格、状态徽章
│   ├── services/            Tauri 调用封装、链接解析
│   ├── stores/              界面状态（Zustand）
│   └── types/               与 Rust 共享的类型定义
├── src-tauri/               Tauri 2 主进程（Rust）
│   ├── src/
│   │   ├── protocol.rs      IPC 消息类型（与 crawler/src/protocol.ts 对应）
│   │   ├── sidecar.rs       Node 进程生命周期与 NDJSON 通信
│   │   ├── commands.rs      Tauri 命令、任务状态机、事件处理
│   │   ├── task.rs          页面归集、文档组装、图片搬运
│   │   ├── merge.rs         合并记录（跨任务追加的依据）
│   │   ├── url.rs           校验 / 规范化 / 去重 / 文档分组
│   │   ├── domain.rs        注册域识别
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
│       ├── extractor/       Readability 正文提取与正文预处理
│       ├── markdown/        Turndown 转换、表格归一化、图片处理
│       ├── pdf/             Markdown → HTML → PDF
│       ├── domain/          robots.txt、防护检测
│       ├── task/            调度、退避、多页发现
│       ├── auth.ts          登录态读取与匹配
│       ├── errors.ts        错误归一
│       └── index.ts         NDJSON IPC 入口
├── tests/
│   ├── unit/                前端单元测试
│   └── integration/         端到端测试与本地 fixture 服务器
├── scripts/                 构建脚本（PowerShell）
├── runtime/                 Node 与 Chromium（不入 Git，由脚本生成）
├── LICENSE                  许可证
└── docs/                    发布说明
```

---

## 开发环境

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.x | 前端构建与 crawler 开发 |
| Rust | 1.98+ | Tauri 主进程 |
| MSVC 生成工具 | VS 2022 Build Tools | Rust 在 Windows 上的链接器 |
| NSIS | 3.x | 生成安装包 |
| WebView2 Runtime | Windows 11 已内置 | 桌面界面运行时 |

安装 Rust 工具链：

```bash
rustup default stable-x86_64-pc-windows-msvc
```

确认 `rustc --print host-tuple` 输出 `x86_64-pc-windows-msvc`。

---

## 构建与测试

安装依赖：

```bash
npm install
npm run crawler:install
```

获取随包运行时（Node 与 Chromium，约 890 MB，不入 Git）：

```bash
powershell -ExecutionPolicy Bypass -File scripts/fetch-runtime.ps1
```

开发模式：

```bash
npm run tauri dev
```

运行全部测试：

```bash
npm run test:all
```

也可分别运行：

```bash
npm run test                # 前端单元测试
npm run crawler:test        # crawler 单元测试
npm run test:integration    # 端到端测试
cargo test --manifest-path src-tauri/Cargo.toml
```

打包：

```bash
powershell -ExecutionPolicy Bypass -File scripts/build-app.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1
```

`scripts/fetch-nsis.ps1` 会在 `build-app.ps1` 中按需自动调用，用于准备打包所需的
NSIS 运行时；网络可达时无需手动干预。

---

## 安装版

产物：`WebScribe-Setup-x64.exe`

1. 运行安装程序，按向导完成安装（默认安装到当前用户目录，无需管理员权限）
2. 从开始菜单启动 WebScribe
3. 卸载通过「设置 → 应用」，或安装目录下的 `uninstall.exe`

> 安装向导会记住上次选择的安装目录。若您希望换一个位置，请在向导中重新选择。

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

两个版本均**内嵌运行时**，使用者无需安装 Node.js、Rust、Python、Git 或任何开发环境。
体积主要来自 Chromium：若只需抓取静态网页，可删除 `runtime\browsers`，
程序会在界面提示浏览器运行时缺失。

---

## 使用方式

1. 把链接粘贴到「粘贴链接」框，按回车或点「添加」
   —— 一行一个、一行多个、直接拖入都可以
2. 在「链接列表」中核对每一条：程序会逐条标出格式是否正确、是否重复、
   将并入哪份文档；可逐条修改或删除
3. 选择输出格式：Markdown（默认）/ PDF / Markdown + PDF
4. 选择图片处理方式：保留远程链接，或下载到本地
5. 按需调整抓取设置
6. 点「选择」指定保存位置
7. 点「开始抓取」

任务表格实时显示每个链接的状态、当前步骤、进度与输出文件路径。
错误会明确展示，不会把失败伪装成成功。

---

## 登录态说明

部分内容需要登录后才能访问。处理流程是：

```
点击「打开浏览器登录」
       ↓
打开一个有头浏览器窗口
       ↓
您自行输入账号 → 自行输入密码 → 自行完成验证码 → 自行完成二次验证
       ↓
关闭窗口 → 保存登录态 → 后续抓取自动复用
```

程序**不会**读取、记录或上传您的明文密码，也**不会**破解验证码、绕过多因素认证
或任何网站登录限制。登录态仅保存在本机。

保存位置：`%APPDATA%\com.webscribe.app\auth\<注册域>.json`

---

## 本机保存的数据

WebScribe 不设数据库、不上传任何数据。它在本机保留两类文件：

| 路径 | 内容 | 说明 |
|---|---|---|
| `%APPDATA%\com.webscribe.app\auth\` | 登录态 | 您主动登录后保存，可随时删除 |
| `%APPDATA%\com.webscribe.app\merge-records.json` | 合并记录 | 记录「文档分组 → 上次产出的文件」，用于判断下次是追加还是新建；可在界面上清除 |
| `%APPDATA%\com.webscribe.app\logs\` | 结构化日志 | 记录任务起止、错误类型等，已脱敏 |

删除 `%APPDATA%\com.webscribe.app\` 即可完全清除用户数据。

---

## 安全说明

### 抓取行为

- **频率**：同站串行 + 跨站并行（上限 3）；同一站点两次请求间隔至少 1 秒
- **重试**：有限重试（上限 3 次），采用指数退避
- **多页发现**：默认关闭，开启后上限 5 页，受同站范围限制与链接去重约束；
  无法可靠判断下一页时停止并提示，不做猜测

### robots.txt

默认严格遵循目标站点的 robots.txt。**您手动填写的链接始终可抓取**——
这是您明确表达的抓取意图；该设置约束的是程序自动续页发现的页面。

### 网站防御机制

遇到验证码、Cloudflare Challenge、403 访问拒绝等情况时，程序会：

```
停止自动抓取 → 向用户显示原因 → 等待用户处理
```

**不会**尝试任何形式的绕过。明确不实现：验证码破解、Challenge 绕过、WAF 绕过、
IP 封禁绕过、频率限制绕过、浏览器指纹伪装、代理池、IP 池、多因素认证绕过、
访问控制绕过。

程序在 HTTP 请求中如实标识自身（`WebScribe/0.1`），不伪装成浏览器。

### 凭据处理

日志按白名单记录字段（时间、链接、任务 ID、阶段、耗时、状态、错误类型），
并对以下内容做脱敏：

- 链接查询串中的敏感参数（token、api_key、password、session 等）
- 请求头中的 Authorization / Cookie / Set-Cookie 整行
- 文本中的 `key=value` 形式凭据

密码、Cookie、Token、Authorization Header、Session ID 均不会写入日志。

### 版本库卫生

`.auth/`、`.storage/`、`.sessions/`、`*.state.json` 以及构建产物、随包运行时
均已加入 `.gitignore`。

---

## 许可证

**本项目的许可证不是任何 OSI 认可的开源许可证。** 完整条款见 [LICENSE](LICENSE)。

简要说明：

- **允许**：个人非商业用途下的使用、编译与修改（自用）
- **禁止**：商业用途；再分发（无论是否修改、是否收费）；移除版权与作者声明
- **要求**：保留版权声明与作者署名

如需上述限制之外的授权，请通过项目仓库与作者联系。

---

## 许可与致谢

本项目使用了以下开源组件，它们各自遵循其原有许可证，不受本项目许可证约束：

- [Tauri](https://tauri.app/) — MIT / Apache-2.0
- [React](https://react.dev/) — MIT
- [Mozilla Readability](https://github.com/mozilla/readability) — Apache-2.0
- [Turndown](https://github.com/mixmark-io/turndown) — MIT
- [Playwright](https://playwright.dev/) — Apache-2.0
- [jsdom](https://github.com/jsdom/jsdom) — MIT
- [robots-parser](https://github.com/samclarke/robots-parser) — MIT
- [marked](https://github.com/markedjs/marked) — MIT
