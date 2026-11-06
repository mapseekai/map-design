# MapDesign

MapDesign 是一个本地优先的地图设计工作台，将地图预览、自然语言制图、可视化样式编辑、制图规范和版本记录组织在同一个项目中。

从已有地图源创建项目后，可以通过 Web 或桌面端调整地图，使用 AI 检查图层和执行样式修改，再结合地图预览与代码编辑细化结果。项目、会话、地图草稿和历史版本由本地 daemon 统一管理，公开地图资源按需加载。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 地图预览与项目导入 | 在首页预览公开 MapLibre Style URL，从 Style、GeoJSON、TileJSON 和 PMTiles URL 创建可编辑项目。 |
| 自然语言制图 | 围绕当前地图提出设计需求，让 AI 查询图层、批量修改样式、验证地图、生成预览并提交版本。 |
| 可视化样式编辑 | 拾取地图要素，按单个要素、属性匹配或整个图层调整颜色、透明度、线宽、圆半径和文字大小。 |
| 样式代码编辑 | 查看和编辑完整 `style.json`，校验通过后保存草稿并更新地图。 |
| 地图评论与参考材料 | 通过要素评论定位修改对象，将当前视口截图和 UTF-8 文本附件加入制图会话。 |
| 会话与任务管理 | 为项目建立多个会话，保存各自的运行时选择，按顺序执行需求，并编辑或移除待发送消息。 |
| 版本管理 | 保存阶段版本、查看历史地图，将历史样式恢复为当前草稿并继续迭代。 |
| 制图规范复用 | 导入、生成、编辑和下载 `CARTOGRAPHY.md`，从已有样式提取设计信息，为项目保存规范快照。 |
| 自动化集成 | 通过 `md` CLI、本地 HTTP API 和 MCP 使用项目管理、任务管理与地图工具。 |

## 开发环境

| 工具 | 版本或用途 |
| --- | --- |
| Node.js | 24.x，与仓库的 `.nvmrc`、`.node-version` 和 `engines.node` 保持一致。 |
| pnpm | 10.33.2，由根目录 `package.json` 的 `packageManager` 指定。 |
| Corepack | 管理项目使用的 pnpm 版本。 |

使用 nvm 的环境可以在仓库根目录执行 `nvm use`，选择项目声明的 Node.js 版本。

## 快速开始

### 启动开发环境

```bash
git clone https://github.com/mapseekai/map-design.git
cd map-design

node --version
corepack enable
pnpm install --frozen-lockfile

pnpm tools-dev start --daemon-port 7456
pnpm tools-dev status
```

运行前使用 `node --version` 确认当前版本为 `v24.x`。`tools-dev start` 管理 daemon、Web 和桌面开发进程，`status` 显示服务状态和访问地址。浏览器打开状态输出中的 Web 地址，即可进入工作台。

上面的命令将 daemon 端口设置为 `7456`。使用其他端口时，命令行客户端连接 `tools-dev status` 显示的 daemon 地址。

### 管理开发进程

```bash
pnpm tools-dev status
pnpm tools-dev logs
pnpm tools-dev restart daemon
pnpm tools-dev stop
```

更新 daemon 源码后，可以构建并重启对应进程：

```bash
pnpm --filter @mapseekai/daemon build
pnpm tools-dev restart daemon
```

详细启动说明见 [QUICKSTART.md](QUICKSTART.md)。

## AI 运行时配置

### API Model

在 **设置 → 运行时 → API Model** 中保存具名模型配置。每项配置包含名称、模型 ID、接口协议、Base URL 和凭据设置。

接口配置提供 OpenAI 兼容协议与 Anthropic 协议；OpenAI 兼容配置可选择 Chat Completions 或 Responses。使用提供免密访问的本地兼容服务时，可以将配置设为免密连接。

添加配置后，点击“保存模型”，再通过“测试连接”验证基础文本响应。模型卡片显示保存状态、测试时间和响应延迟。连接测试会发送实际模型请求，费用按所用服务的计费规则计算。

已保存的配置可设为默认模型，也可在项目创建表单和会话运行时选择器中单独选择。配置管理提供编辑和删除操作；同一个远程模型可以使用不同的名称、服务地址和凭据保存为多项配置。

地图编辑使用具备工具调用能力的模型，截图参考使用具备图像输入能力的模型。设置中的 API 执行预算可调整模型步骤、工具调用次数、地图编辑输出长度和制图规范生成输出长度。

API Key 由本地 daemon 保存，界面通过凭据状态标识展示保存情况。每轮任务记录实际使用的运行时与模型，便于回看执行来源。

详细说明见 [API 模型配置](docs/api-model-profiles.md)。

### 可选运行时

MapDesign 提供以下运行时适配：

| 运行时 | ID | 接入方式 |
| --- | --- | --- |
| API Model | `api` | daemon 调用已配置的模型服务。 |
| Codex | `codex` | Codex app-server 会话。 |
| Pi | `pi` | Pi SDK 适配器。 |
| Oh My Pi | `oh-my-pi` | Oh My Pi RPC。 |
| OpenCode | `opencode` | OpenCode 工具插件。 |
| DeepSeek Harness | `deepseek-harness` | 专用运行配置与工具协议。 |

本地 Agent 完成安装与登录后，工作台根据运行时检测和模型目录提供可选项。每个会话保存自己的运行时选择，后续需求按该会话的配置执行。

## 制图工作流

### 1. 预览地图并创建项目

在首页输入公开 MapLibre Style URL，缩放和平移地图，观察已有图层与视觉效果。例如：

```text
https://demotiles.maplibre.org/style.json
```

使用允许浏览器跨域访问的公开地图资源，供 Style、瓦片、字体和图标按需加载。

创建项目时填写项目名称、地图源地址和设计需求，选择运行时、模型及制图规范。项目导入接受 Style、GeoJSON、TileJSON 和 PMTiles URL；首页即时预览使用 MapLibre Style URL。

制图规范可以选用默认内置的莫奈风格，也可以从规范库选择已有文档。桌面端提供项目工作目录选择入口。

设计需求示例：

> 为城市步行导览设计一张浅色底图。以暖白色作为背景，使用柔和的蓝色表现水系，使用浅绿色表现公园。突出步行道路和街区轮廓，并在不同缩放级别保持清晰的道路与地名层级。完成修改后验证地图并生成预览。

创建操作保存项目与初始需求，地图导入完成后开始首轮制图任务。

### 2. 通过会话迭代设计

在会话中说明修改对象、目标效果和使用尺度。AI 结合当前地图、会话历史、所选制图规范及附件执行任务，界面展示回复、运行状态和工具活动。

例如，可以先安排整体配色，再调整道路层级，最后检查文字标签。当前任务执行期间，后续需求进入待发送队列；待发送项可以编辑和移除。

项目内可以创建多个会话，分别讨论配色、道路或标注。各会话保存独立的消息和运行时选择，共同使用项目地图，项目内的 AI 修改按顺序执行。

地图评论可关联单个要素、属性匹配结果或整个图层。当前视口截图用于提供视觉参考，UTF-8 文本附件用于补充设计简报、字段说明和分类清单。

### 3. 精细调整样式

打开地图铅笔工具，拾取要素并选择作用范围。控件根据图层类型提供颜色、透明度、线宽、圆半径和文字大小等选项。调整时即时预览，保存时校验并写入草稿。

切换到代码视图可以编辑完整 `style.json`，精确调整表达式、缩放范围、过滤条件与图层顺序。编辑内容通过 JSON 和样式结构校验后自动保存，并同步更新地图预览。

### 4. 保存和回看版本

地图草稿保存连续修改，已提交版本记录阶段成果。验证草稿并生成对应预览后，可以在版本面板提交，也可以通过 AI 地图工具完成提交。

版本面板展示版本号、提交时间和样式摘要。选择历史版本可查看对应地图；将其恢复为当前草稿后，可以继续编辑和提交新版本。

会话消息、任务记录和版本历史保存在本地，重新打开项目后可继续查看与使用。

完整操作说明见 [中文使用指南](docs/usage.zh-CN.md)。

## CARTOGRAPHY.md 制图规范

`CARTOGRAPHY.md` 用于描述地图的颜色、字体、线宽、尺寸、透明度、视觉层级和尺度策略。MapDesign 使用 0.4.0 文档格式，并通过 `@mapseekai/cartography.md` 0.4.1 执行解析与格式校验。

规范库提供文件上传、在线文档导入、AI 生成和文档编辑入口。默认内置莫奈风格预设位于 `design-systems/monet/CARTOGRAPHY.md`。

### 从已有样式提取规范

`cartography-init` 从以下文件中提取设计信息，生成可继续审阅和编辑的规范草稿：

| 来源 | 输入文件 |
| --- | --- |
| MapLibre | `style.json` |
| QGIS | `.qgs`、`.qgz` |
| ArcGIS | `.lyrx`、`.stylx` |
| SLD | `.sld` |

提取产物包括 `CARTOGRAPHY.md`、人类可读的 `INIT_REPORT.md` 和机器可读的 `INIT_REPORT.json`。报告记录来源、提取结果与绑定信息，供设计审阅和后续处理使用。

设计规则保存在规范文档中，具体数据源、字段及样式绑定由运行时管理。项目创建时保存所选规范的完整快照，使会话上下文、地图检查和版本记录引用同一份设计依据。

规范管理提供文档和报告下载入口，规范库中的文档可用于后续地图项目。

实现说明见 [制图规范运行机制](docs/cartography-runtime.md)与 [cartography-init](skills/cartography-init/SKILL.md)。

## 命令行与接口

### md 命令行

`md` 与 Web、桌面端连接同一个 daemon，使用同一份项目状态。

| 命令 | 用途 |
| --- | --- |
| `md agents` | 查询运行时与模型检测信息。 |
| `md config` | 读取和更新应用配置。 |
| `md status`、`md doctor` | 查询 daemon 健康状态。 |
| `md project` | 创建、查询、删除项目，以及重新执行项目导入。 |
| `md run` | 提交需求、查询运行状态和取消任务。 |
| `md tool` | 调用地图领域工具。 |

源码环境可通过 `node apps/daemon/bin/md.mjs` 使用 CLI。以下命令在仓库根目录执行，并连接快速开始中指定的端口：

```bash
node apps/daemon/bin/md.mjs status --daemon-url http://127.0.0.1:7456 --json
node apps/daemon/bin/md.mjs agents list --daemon-url http://127.0.0.1:7456 --json
node apps/daemon/bin/md.mjs project list --daemon-url http://127.0.0.1:7456 --json
```

在设置中保存并设定默认 API Model 后，可以使用下面的 Bash 示例创建地图项目：

```bash
printf '%s\n' '设计一张浅色城市步行底图，突出公园、水系和步行道路，完成后验证并生成预览。' \
  | node apps/daemon/bin/md.mjs project create \
      --daemon-url http://127.0.0.1:7456 \
      --name "城市步行底图" \
      --source-url "https://demotiles.maplibre.org/style.json" \
      --runtime api \
      --prompt-file - \
      --json
```

`--prompt-file -` 从标准输入读取设计需求，也可以使用 `--prompt-file` 指定本地 UTF-8 文件。`--daemon-url` 可通过环境变量 `MAP_DESIGN_DAEMON_URL` 统一配置。

### 地图工具

原生 Agent 工具、HTTP 工具接口和 MCP 共用地图领域操作：

| 工具 | 用途 |
| --- | --- |
| `map_get_context` | 获取当前地图、版本与设计依据。 |
| `map_inspect` | 查看地图、数据源和图层信息。 |
| `map_search_layers` | 查找目标图层。 |
| `map_apply_transaction` | 在同一事务中应用一组地图修改。 |
| `map_update_semantics` | 更新地图语义信息。 |
| `map_validate` | 验证当前地图。 |
| `map_render_preview` | 请求地图预览。 |
| `map_commit_revision` | 根据验证与预览结果提交版本。 |
| `map_discard_draft` | 将草稿恢复至已提交状态。 |

工具调用使用 daemon 签发的项目与运行授权。写入操作携带版本与幂等信息，使样式变更、验证、预览和提交建立明确关联。

接口约定见 [技能协议](docs/skills-protocol.md)与 [地图工具约定](docs/map-tool-efficiency.md)。

## 项目架构

Web 客户端使用 React、Next.js 和 MapLibre GL JS，桌面端使用 Electron。本地 daemon 通过 HTTP API 管理项目与任务，使用 SQLite 保存状态，并负责 Agent 调用和地图领域操作。

```text
map-design/
├── apps/
│   ├── web/                    # Web 工作台
│   ├── daemon/                 # 本地 API、SQLite、CLI、MCP 与 Agent 编排
│   ├── desktop/                # Electron 桌面宿主
│   └── packaged/               # 打包应用的启动与进程管理
├── packages/
│   ├── components/             # 共享界面组件
│   ├── contracts/              # 共享 API 与运行时契约
│   └── map-design-contracts/    # 地图领域类型与契约
├── skills/
│   ├── map-design/             # 地图设计工作流
│   ├── cartography-md/         # 制图规范创作与编辑
│   ├── cartography-init/       # 从已有样式提取规范
│   └── data-profile/           # 数据上下文相关技能
├── design-systems/             # 制图规范与内置预设
├── tools/
│   ├── dev/                    # 开发进程管理
│   └── pack/                   # 安装包构建与应用生命周期管理
├── e2e/                        # 端到端测试
└── docs/                       # 使用与开发文档
```

客户端通过共享契约访问 daemon。地图源经导入流程形成项目草稿，后续修改经过校验和预览形成提交版本。Web、桌面端、CLI 和 Agent 工具围绕同一份项目状态工作。

架构说明见 [docs/architecture.md](docs/architecture.md)。

### 本地数据

`MAP_DESIGN_DATA_DIR` 用于指定 daemon 的本地数据根目录，保存数据库、项目文件、配置和 Agent 状态。直接启动源码 daemon 时，默认目录为当前工作目录下的 `.map-design`；开发工具和打包启动器管理各自的数据位置。

通过 Bash 显式设置开发数据目录：

```bash
export MAP_DESIGN_DATA_DIR="$HOME/MapDesignData"
pnpm tools-dev start --daemon-port 7456
```

备份项目时，先正常停止应用和 daemon，再复制完整数据目录并保留文件访问权限。数据目录及日志、缓存的位置说明见 [本地数据管理](docs/local-data.md)。

## 验证与测试

在仓库根目录运行代码检查与类型检查：

```bash
pnpm lint
pnpm guard
pnpm typecheck
```

运行 daemon 与 Web 的包级测试：

```bash
pnpm --filter @mapseekai/daemon test
pnpm --filter @mapseekai/web test
```

API 模型配置的浏览器工作流使用隔离的本地 daemon、Web 和模型测试服务：

```bash
pnpm --dir e2e exec playwright test \
  -c playwright.config.ts ui/api-profile-settings.test.ts --workers=1
```

根据修改涉及的包选择对应测试，并结合本地运行或安装包流程检查用户操作。

## 桌面应用构建

`tools-pack` 提供 macOS、Windows 和 Linux 的安装包构建入口。以下命令分别在对应平台的构建环境执行：

```bash
pnpm tools-pack mac build --to all
pnpm tools-pack win build --to all
pnpm tools-pack linux build --to appimage
```

| 平台 | 构建产物 |
| --- | --- |
| macOS | DMG、ZIP。 |
| Windows | NSIS 安装程序、便携 ZIP。 |
| Linux | AppImage。 |

Windows NSIS 构建使用 `makensis`。macOS 构建可结合发布凭据执行签名和公证。

安装包工具同时提供安装、启动、状态检查和停止操作。以 Linux 为例：

```bash
pnpm tools-pack linux install
pnpm tools-pack linux start
pnpm tools-pack linux inspect
pnpm tools-pack linux stop
```

发布工作流位于 `.github/workflows/release.yml`，按 `v<version>` 标签执行版本检查、源码校验和平台构建，生成 SHA-256 校验和，并创建 GitHub Release。

详细配置见 [tools/pack/README.md](tools/pack/README.md)。

## 文档与贡献

| 文档 | 内容 |
| --- | --- |
| [中文使用指南](docs/usage.zh-CN.md) | 地图创建、会话、样式编辑和版本操作。 |
| [快速开始](QUICKSTART.md) | 启动、CLI 示例与开发验证。 |
| [API 模型配置](docs/api-model-profiles.md) | 模型保存、连接测试、选择和凭据管理。 |
| [Agent 适配器](docs/agent-adapters.md) | 运行时接入与适配方式。 |
| [制图规范运行机制](docs/cartography-runtime.md) | 规范格式、项目快照与运行时引用。 |
| [本地数据管理](docs/local-data.md) | 数据目录、生命周期与备份。 |
| [文档索引](docs/README.md) | 使用、架构和开发文档入口。 |

开发变更围绕地图项目、导入、样式草稿、验证、预览、版本及运行时组织。客户端与 daemon 通过共享契约协作，界面文案同步维护项目的各语言资源，并为对应变更补充验证。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MapDesign 使用 Apache License 2.0，详见 [LICENSE](LICENSE)。
