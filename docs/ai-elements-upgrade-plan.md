# AI Elements 对话体验升级：排查与实施规划

文档性质：历史调研与待评估方案，未作为当前功能清单。组件位置、缺口和上游版本均以当时为准；实施前应重新核对。当前使用方式见[使用说明](usage.zh-CN.md)。

日期：2026-09-22。范围：当前工作树的地图工作区、CARTOGRAPHY 文档编辑器及共享聊天组件。

本轮只做调研和规划，没有安装 AI Elements、修改业务代码或调整依赖。下文“现状”来自源码及现有测试定义；测试定义并不代表本轮已运行通过。工作树已有较多未提交改动，包含 ConversationSession 和消息队列；后续实施必须以届时工作树为基线。

## 1. 结论与采用策略

值得采用，但应按组件引入、适配项目，而不是用官网完整 Chatbot 示例替换当前对话系统。

推荐顺序：

1. **先处理兼容性，试接 Attachments。** 验证 React 18、Base UI、monorepo aliases、样式归属和直接依赖。
2. **第一批改善附件与输入区。** 可见上传错误、受限文件拖放/粘贴、文件详情、统一截图与文本附件展示、输入框自动增长。
3. **第二批改善阅读体验。** 两处对话共用滚动策略、消息级复制、空状态建议；独立验证流式 Markdown，再决定迁移 MessageResponse。
4. **第三批整理运行过程。** 适配 Tool / Reasoning 的组合结构，保留安全摘要、取消状态、用户展开偏好；Queue 主要补充可读性，不重写调度。
5. **后续按业务需要考虑 Checkpoint / Artifact。** 多模态文件、审批、分支、token 用量等必须先有真实数据和服务端能力。

建议将“正式采用”定义为：选取上游源码，记录来源版本，使用项目已有基础组件完成适配，并有回归证据。不是简单安装完 CLI 就算完成。

## 2. AI Elements 是什么，适合承担什么

AI Elements 是基于 shadcn/ui 的组件源码注册表。`npx ai-elements@latest add attachments` 将选定组件源码及其依赖加入项目；源码由项目维护，并非安装后所有聊天功能自动生效的完整产品。[官方介绍](https://elements.ai-sdk.dev/)、[安装指南](https://elements.ai-sdk.dev/docs/setup)

项目使用 pnpm，未来试装采用 `pnpm dlx ai-elements@<已核验版本> add attachments`。执行位置、生成目录和共享包归属先通过隔离试装确认；不在当前工作树直接运行全量安装或覆盖命令。本轮没有执行安装。

| 上游组件 | 对本项目的价值 | 不由组件提供的能力 |
| --- | --- | --- |
| Attachments | 文件、截图的 inline / grid / list 组合展示，详情和移除入口 | 服务端上传、文件校验、持久化、模型识图与文档解析 |
| Prompt Input | 输入区结构、自动增长、文件拖放、粘贴和状态按钮 | MapDesign 的 Run 接受语义、队列调度、项目权限与运行锁 |
| Conversation | 滚动容器、回到最新、空状态等基础结构 | 历史加载、消息恢复、跨会话生命周期、列表虚拟化保证 |
| Message / MessageResponse | 消息操作区与流式 Markdown 渲染 | 问答表单解析、地图色值预览、消息分支持久化 |
| Tool / Reasoning | 工具活动和公开思考摘要的折叠展示 | 工具执行、审批协议、敏感信息脱敏 |
| Queue | 有分组、操作与附件的待处理列表 | 顺序派发、暂停恢复、幂等与持久化 |
| Model Selector | 可搜索、可分组的选择界面 | agent 能力检测、runtime revision 校验、推理档位与服务等级策略 |

依据：[Attachments](https://elements.ai-sdk.dev/components/attachments)、[Prompt Input](https://elements.ai-sdk.dev/components/prompt-input)、[Conversation](https://elements.ai-sdk.dev/components/conversation)、[Message](https://elements.ai-sdk.dev/components/message)、[Tool](https://elements.ai-sdk.dev/components/tool)、[Reasoning](https://elements.ai-sdk.dev/components/reasoning)、[Queue](https://elements.ai-sdk.dev/components/queue)、[Model Selector](https://elements.ai-sdk.dev/components/model-selector)。表中业务边界为结合本项目源码后的判断。

## 3. 当前技术边界

| 维度 | 当前项目 | 接入判断 |
| --- | --- | --- |
| React | web 和共享组件均为 18.3.1 | 官方 Setup 要求 React 19；不能声称最新源码开箱兼容 React 18。先做小范围验证，不把全项目 React 升级捆绑进 UX 改造 |
| Next / Tailwind | Next 16.2.6、Tailwind 4.3.3 | 具备基础条件，但需要验证生产构建的源码扫描 |
| UI 基础 | shadcn Base UI Nova，已有 forwardRef 适配 | 上游有 Radix 组合、`asChild` 等用法；按 Base UI `render` / focus API 适配 |
| AI SDK | daemon 的 `ai` 为 7.0.93；web 未声明 `ai` 或 `@ai-sdk/react` | 本次读取的上游 elements package 声明 `ai ^6.0.105`。不降级 daemon，也不直接把上游类型扩散进共享业务契约 |
| 通信 | daemon Run API + 自定义 SSE 事件、消息快照 | 展示组件接收现有状态；不引入第二套 useChat 状态机 |
| 组件归属 | `packages/components` 持有通用 UI，web 持有业务组合 | 通用 AI 展示组件放共享包；文件上传、MapDesignMessage、Run 适配留在 web |
| 样式 | DESIGN.md、semantic tokens、no-restyle | 不照搬官网品牌色、默认高亮色或页级 restyle；检查新组件路径是否符合 lint ownership |
| 本地优先 | daemon 管理状态、凭据和文件 | 不需要为 UI 改造增加 AI Gateway 或浏览器直连模型 |

本地依据：`apps/web/package.json`、`apps/daemon/package.json`、`packages/components/package.json`、两处 `components.json`、`docs/ui.md`、`eslint.config.mjs`。

上游依据：[Setup](https://elements.ai-sdk.dev/docs/setup)、[elements package.json](https://github.com/vercel/ai-elements/blob/main/packages/elements/package.json)、[HoverCard 源码](https://github.com/vercel/ai-elements/blob/main/packages/shadcn-ui/components/ui/hover-card.tsx)、[Prompt Input 源码](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/prompt-input.tsx)。这些 main 链接是调研时读取的动态来源，正式引入时需固定版本/提交并记录差异。

### 特别需要避免的两处行为回退

- **发送失败丢草稿。** `MapDesignComposer.tsx:100` 的 `onSend` 返回 `boolean | Promise<boolean>`，只有 `true` 才清理本次发送的数据，并通过编辑代数保留发送期间的新输入。上游 PromptInput 将“没有抛异常 / Promise resolve”视为清理时机，且非 provider 路径会先 `form.reset()`。`false` 不能直接交给上游回调。保留项目受控草稿及清理逻辑，或修改本地引入源码明确识别接受结果。
- **把取消当成拒绝/失败。** MapDesign 工具结果有 `canceled`；上游 Tool 状态中的 `output-denied` 表示拒绝批准，不等价于用户取消 Run。必须保留单独的取消展示，不强行套状态枚举。

## 4. 现有对话表面与真实缺口

### 4.1 两个入口，共享组件，能力并不相同

地图工作区路径：

`MapDesignWorkspace → MapDesignChatPane → ConversationSession → MapDesignChatSurface / MapDesignMessage / MapDesignComposer`

文档编辑路径：

`CartographyEditor → MapDesignChatSurface / MapDesignMessage / MapDesignComposer`

桌面端承载 web 界面，因此共享 UI 改造通常会覆盖桌面聊天，但 Electron 的链接打开、粘贴和焦点仍需单独验收。

| 能力 | 地图工作区 | CARTOGRAPHY 文档编辑 |
| --- | --- | --- |
| 消息与输入展示 | 共享组件 | 共享组件 |
| Run 更新 | 自定义 SSE、事件快照与终态消息 | session 轮询及 conversation 刷新 |
| 文本附件 | 已接入 | 未传入附件及上传回调 |
| 地图截图 | 已接入 | 未传入截图 |
| 消息队列 | 当前工作树已接入 | 未开启 queueEnabled |
| 滚动 | 24px 底部阈值、ResizeObserver、回到底部 | 仅在 messages.length 变化时直接滚到底部 |
| 提问表单 | 当前未回答项可提交 | Message 传 submitDisabled |
| 提示词长度 | 默认 16,384 字符 | 8,000 字符 |

因此应共用阅读与展示原语，显式区分可上传、可排队等能力。文档编辑器不能因为换了输入组件，就出现实际不可用的上传/队列入口。

### 4.2 附件：第一优先级

位置：`MapDesignComposer.tsx:124,164,172,233`、`MapDesignMessage.tsx:103`、`text-attachments-client.ts`。

已经存在：

- 选择 TXT/Markdown、CSV/TSV、JSON/GeoJSON；前端校验并上传到 daemon。
- 输入区移除文件、消息内打开文本附件、地图截图缩略图。
- 上传时阻止提交、切换项目/卸载时中止上传、仅清理已发送附件。
- 契约提供附件名称、字节大小及项目作用域下载 URL。

已确认缺口：

- `uploadError` 只渲染在 `sr-only` 区域，错误没有可见反馈。
- 文件选择是当前上传入口，未见 composer 的文件拖放或粘贴处理。
- 上传只显示总体状态，没有逐文件待上传/失败/重试展示。
- 文本附件只显示图标和文件名，未利用 byteLength；截图和文件是两套展示结构。
- 点击附件或截图主要打开新标签，缺少对话内查看上下文的轻量详情。

建议：

- 用 Attachments 的组合方式统一输入区、消息区、队列内的附件展示；文件使用紧凑 inline/list，地图截图使用 grid。
- 提供完整文件名、真实扩展名、大小；失败状态可见且可通过键盘重试/移除。没有上传进度数据时只显示“上传中”，不显示假百分比。
- 文件预览先显示元信息；必要时用户显式打开再读取 daemon 文本内容，避免 hover 就批量加载。
- 桌面可 hover 补充信息，但点击、触摸、键盘必须能完成同样操作。移除按钮不能只在 hover 时可用。
- 拖放限定在聊天区域；不要启用 globalDrop 抢占地图资源导入。粘贴优先保留普通文本，仅拦截符合当前文件白名单的文件项。
- 先保留 `MapTextAttachment` / `MapScreenshot` 业务契约。仅在 UI 层映射 `id / filename / mediaType / url`；继续通过现有 URL helper 访问文件。

能力限制需要明确展示：

- 文本附件仅 `.txt .md .csv .tsv .json .geojson`，单文件 64 KiB，最多 4 个，总计 128 KiB。
- 当前文本附件的 mediaType 是统一 `text/plain`；显示格式标签可依据允许的扩展名，不能假称后端有任意文件 MIME 支持。
- 地图截图是另一类资源：单张最多 4 MiB、最多 4 张，带 draftRevision、styleHash、viewport 等地图元信息。
- 任意 PNG/JPEG 粘贴、PDF、视频、音频不属于这批“纯 UI 接入”。图库截图也不等同于普通图片上传，需另行设计资源契约、校验及 agent 能力处理。

依据：`packages/contracts/src/api/map-text-attachments.ts`、`map-screenshots.ts`。上游展示能力：[Attachments](https://elements.ai-sdk.dev/components/attachments)。

### 4.3 输入区：适配 Prompt Input 结构，保留提交控制

当前已有 Enter 发送、Shift+Enter 换行、中文 IME 防误发、发送/停止、runtime 切换、CARTOGRAPHY 引用、队列入口和失败保留草稿。不能作为“待新增能力”重复规划。

推荐改善：

- 在现有 InputGroup 基础上采用 PromptInput Header / Body / Footer 的分区，明确附件、正文和操作区的层次。
- 输入框从当前可手动拉伸改为有上下限的自动增长，长提示词时在框内滚动；保留足够消息阅读空间。
- 运行中“加入队列”与“停止”保持独立，不能直接套用只切换发送/停止的默认按钮行为。
- 错误紧邻对应输入/附件显示；停止中、上传中、runtime 保存中应有可辨识状态。
- 保留已有 runtime chip 的高级能力，窄聊天栏时防止与附件、发送按钮互相挤压。

可用上游结构，不建议第一批整体替换其文件状态 provider 和提交逻辑。[Prompt Input](https://elements.ai-sdk.dev/components/prompt-input)

### 4.4 消息与 Markdown：有收益，但迁移成本高于附件

位置：`MapDesignMessage.tsx`、`apps/web/src/runtime/markdown.tsx`。

已有 Markdown 并不简陋：支持标题、列表、GFM 表格、代码高亮/复制/折叠、色值色块、代码评论指令等。消息也有 runtime 来源、任务活动、截图/附件和结构化提问表单。

推荐先引入 Message / MessageActions 的组合：正文下方提供消息复制及成功/失败反馈；不要在没有业务端点时增加反馈、重新生成或分支按钮。工具动作可能改变地图，不能直接照搬 `regenerate()` 示例。

MessageResponse 的价值主要在流式 Markdown 的不完整语法处理及 CJK 等支持。独立试验后再迁移：

- 保留问答表单提取层，仅把普通文本片段送给新 renderer；不能把 `<question-form>` 当 HTML 渲染。
- 保留六位/其他已有合法色值色块、代码评论、自定义链接处理及安全图片策略。
- 终态以 message.content 为权威，不能用截断的事件文本覆盖完整回复。
- 配置 Streamdown 的生产 Tailwind source 扫描；核对 React peer、Shiki 主版本以及真正需要的插件。
- 初期不为“组件齐全”引入 Mermaid、数学等未明确需要的插件；以实际生产包增量决定。
- 保留消息 memo、稳定对象引用与现有 content-visibility；Conversation 本身不保证长列表性能。

来源：[Message](https://elements.ai-sdk.dev/components/message)、[上游 message 源码](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/message.tsx)。

### 4.5 滚动与空状态：优先统一两个入口

地图对话已经能自动跟随、手动上翻后暂停跟随、点击回到最新，并考虑 reduced motion。无需把这些能力重新算作新特性。

文档对话目前的长度依赖滚动会在新增消息时直接到底，同一条消息变长时不触发。建议统一到一个受控 Conversation 容器；切换前只有一个滚动控制者，避免 ResizeObserver 与 use-stick-to-bottom 双重控制。

目标行为：用户在底部时跟随；阅读旧消息时保持位置；新内容出现时提供回到最新入口；切换会话保持对应位置；内容展开和附件加载不无故把用户拉回底部。

空状态可使用 ConversationEmptyState + Suggestion：根据项目是否已有地图、是否在只读 revision、agent 是否可用给出少量动作建议。点击建议填入草稿供用户编辑，避免点击即启动地图修改。

### 4.6 工具活动与公开思考摘要

位置：`TaskActivityCard.tsx`、`MapToolActivityCard.tsx`、`ThinkingBlock.tsx`。

已经有工具 ID 配对、乱序结果处理、状态图标、折叠、脱敏摘要、未知工具回退及遗漏工具聚合。更适合复用 Tool / Reasoning 的展示结构，不替换事件归并逻辑。

具体改善：

- 概要行集中展示当前阶段、工具执行概况；地图结果以验证错误数、修改图层数等**已有安全字段**表达。
- SafeSummary 当前直接显示字段 key；为已知字段补本地化标签和值格式，未知字段保持安全回退。
- 成功工具默认收起、失败工具容易找到；不让每个工具都展开大段 JSON。
- 当前测试明确要求“运行结束后保留用户/实时展开状态”。上游 Reasoning 的自动收起默认行为不能直接覆盖这一约定；保持受控 open，有需要再单独改变产品约定和测试。
- 只展示服务端公开的 thinking 事件；不推断缺失过程或填充模拟进度。
- 聚合 live region 宣告状态，避免每个 token 和工具行反复打断屏幕阅读器。

仅将脱敏 summary 交给内容区。不要为了套 ToolInput / ToolOutput 传入原始参数、文件路径、凭据或模型原始返回。

来源：[Tool](https://elements.ai-sdk.dev/components/tool)、[Reasoning](https://elements.ai-sdk.dev/components/reasoning)。

### 4.7 队列与模型选择：已有能力较多，优先级较低

当前工作树的 `MapDesignMessageQueue` / `useQueuedMapMessages` 已有：顺序派发、行内编辑、删除、暂停/继续、只锁定正在提交项、错误/取消暂停、会话切换保留待发项、附件数量提示和键盘焦点恢复。

Queue 的增量价值：长队列折叠、附件摘要一致性、条目状态更清晰。保留现有 hook；不要换成官网演示状态。队列当前是内存状态，会话切换保留不等于刷新后持久化；刷新恢复若需要，应单独立项。

RuntimeSwitcher 已有模型搜索、agent 可用性、定制模型、推理档位、服务等级、偏好记忆、确认保存及 runtime revision。Model Selector 的主要可能收益是结果列表的统一键盘导航和分组。除非实际 UI 验证有明确收益，否则维持现有对话框更划算。

来源：[Queue](https://elements.ai-sdk.dev/components/queue)、[Model Selector](https://elements.ai-sdk.dev/components/model-selector)。

## 5. 暂缓项

| 组件/能力 | 暂缓原因 | 进入实施的前提 |
| --- | --- | --- |
| Confirmation | 现有 question form 是信息收集，不等于工具批准 | daemon 有明确批准请求 ID、响应与恢复协议，再用组件展示 |
| MessageBranch / Regenerate | 地图工具有状态副作用；切换文本分支不等于切换地图状态 | 明确历史、revision、重放和运行策略 |
| Context / token 占用 | 当前公开事件契约未提供完整 usage | daemon 暴露可靠使用量及适用模型窗口，不能伪造数字 |
| Sources / Inline Citation | 需要结构化来源信息 | 有可追溯的资源/文档引用，而不是从任意回复链接拼来源 |
| Checkpoint / Artifact | 有地图 revision/preview 概念，但需建立与消息的可靠关联 | 先做只读“查看对应版本/预览”；恢复动作单独走已有 revision 流程 |
| PDF、普通图片、音视频、Speech Input | 展示能力超过当前上传和 agent 能力 | 完整资源契约、daemon 校验、各 runtime 能力与失败体验 |
| Web Preview / JSX Preview / Terminal | 当前对话核心产物为地图，已有地图预览和受控工具摘要 | 有具体业务需求再评估，不以聊天升级为由引入任意代码/终端展示 |

参考：[Confirmation](https://elements.ai-sdk.dev/components/confirmation)、[Checkpoint](https://elements.ai-sdk.dev/components/checkpoint)、[Message 分支说明](https://elements.ai-sdk.dev/components/message)。

## 6. 分批实施清单

以下是后续执行计划，均未在本轮实施。

| 阶段 | 交付物与主要文件 | 前置条件 | 完成标准 |
| --- | --- | --- | --- |
| A：兼容试接 | 隔离目录检查选定版本 Attachments；记录生成源码、依赖和差异；确定共享组件目录/export；更新 docs/ui 与 DESIGN 的聊天约定 | Node 24、当前工作树变更边界确认 | React 18 ref、Base UI trigger/focus、生产样式扫描和导出均验证；未引入 Radix runtime |
| B：附件和输入 | 共享 Attachments 原语；web 附件适配；MapDesignComposer / MapDesignMessage / text-attachments-client / locales | A 通过 | 支持现有白名单文件的选择/局部拖放/粘贴；可见错误和重试；不丢草稿/附件；无不可用上传入口 |
| C：阅读表面 | MapDesignChatSurface、ConversationSession、CartographyEditor、MapDesignMessage；空状态建议和消息复制 | B 稳定 | 两入口阅读滚动一致，上翻不抢位置，复制有反馈，空状态动作与项目能力相符 |
| D：流式正文 | 单独验证 MessageResponse；必要的 renderer extension；index.css source 扫描 | C、兼容/包增量通过 | 不完整 Markdown 与 CJK 可靠，色块/表单/安全链接回归通过，历史消息不随无关流更新重绘 |
| E：运行可读性 | TaskActivityCard、MapToolActivityCard、ThinkingBlock、MapDesignMessageQueue、所有 locales | B/C；队列在当前工作树的开发基线稳定 | 脱敏摘要和取消语义正确，用户展开偏好保留，队列编辑/暂停/派发语义不变 |
| F：地图产物联动 | 消息中的 revision/preview 只读入口，必要时补 contracts 和 daemon 返回 | 明确消息与产物关联 | 点击能打开真实对应版本；无虚假 checkpoint 或未经定义的恢复行为 |

组件归属建议：

- 基础交互原语仍在 `packages/components/src/ui/`，仅补缺失的 Base UI 原语。
- 通用 AI 组合原语可放 `packages/components/src/ai-elements/` 并增加明确 export；先核对 no-restyle 配置的作用范围，不通过关闭消费者检查解决样式冲突。
- `apps/web/src/map-design/chat/` 保留上传、运行、队列、表单、文件 URL 和消息适配。
- `packages/contracts` 保留项目协议，不导入 AI Elements UI 类型或 @ai-sdk/react。
- 一次只替换一种状态所有者：先展示，后评估输入/滚动；不同时重写 Run、renderer 和 queue。

## 7. 验收场景

### 第一批必须覆盖

1. 添加一个合法 CSV：显示完整名称和大小，可移除，可发送；历史消息打开正确项目附件。
2. 超大文件、超过数量/总量、非法扩展名：普通用户能看到原因；读屏可获知；已有合法文件保留。
3. 上传中取消/移除、上传失败重试、重复文件、批次部分成功：状态与实际结果一致，不重复发送已成功文件。
4. 输入期间异步发送被拒绝：草稿、附件、截图仍在；已编辑的新文本不被旧请求清空。
5. 中文 IME Enter 不提交；Enter 发送；Shift+Enter 换行；模型搜索 Enter 不触发表单发送。
6. 文件拖到地图区域仍按地图资源流程处理；拖到聊天区才成为聊天文本附件；普通文本粘贴不被吞掉。
7. 切换会话/项目、查看只读 revision、agent 不可用：上传、发送、队列和 runtime 切换能力正确。
8. 键盘和触摸可以预览/移除附件，关闭详情后焦点回到触发器；错误及图标操作全部本地化。

### 阅读与运行回归

9. 流式更新中阅读历史，不被拉到底部；点击回到最新后恢复跟随；附件加载、工具展开不异常跳动。
10. 工作区和文档编辑器分别测试消息增长、会话切换和取消；不能因共用组件而混入不支持的能力。
11. 流式半截代码块/表格/链接、长 JSON、中英文混排；完成后使用权威终态内容。
12. 色值色块、代码复制/折叠、问答表单、特殊链接、安全本地图片维持；远程 Markdown 图片仍不自动请求。
13. 工具正常、失败、取消、未知工具、结果先于开始、重复事件、遗漏工具聚合：可读且不泄露原始数据。
14. 队列连续提交、编辑暂停、删除、失败暂停、停止暂停、继续、会话切换、双击操作：行为与现有约定一致。
15. 保留实时活动的手动展开/收起；历史终态默认收起；屏幕阅读器不被每个 token 重复打断。
16. 375 / 768 / 1280px 与桌面窗口、窄聊天栏、长文件名、RTL、reduced motion 下操作可达，输入区不被队列撑出视口。
17. 在同一份长历史 fixture 下比较前后渲染：关注无关历史消息重绘、滚动卡顿、生产包增量；本轮不提供未测量的性能数字。

沿用与扩充现有测试，而不是建立平行体系：

- `apps/web/tests/map-design/chat/MapDesignComposer.test.tsx`
- `apps/web/tests/map-design/chat/MapDesignMessage.test.tsx`
- `apps/web/tests/map-design/chat/MapDesignChatPane.test.tsx`
- `apps/web/tests/map-design/chat/MapDesignRuntimeSwitcher.test.tsx`
- `apps/web/tests/map-design/chat/TaskActivityCard.test.tsx`
- `apps/web/tests/map-design/chat/MapToolActivityCard.test.tsx`
- `apps/web/tests/map-design/chat/ThinkingBlock.test.tsx`
- 当前工作树的 `queued-composer.test.tsx`、`queued-conversation.test.tsx`、`useQueuedMapMessages.test.tsx`
- `apps/web/tests/map-design/CartographyEditor.test.tsx`
- `e2e/ui/map-design-studio.test.ts`、`map-design-message-queue.test.ts`、`cartography-ai-creation.test.ts`

执行阶段先确认 Node v24.x，再运行相关共享组件与 web 检查、生产构建、lint ownership/guard 和针对性 e2e。若涉及协议才追加 daemon/contracts 的聚焦检查。最后必须在真实浏览器与桌面表面驱动上述交互。

## 8. 本轮证据与限制

- 已读官方组件文档和上游 attachments、prompt-input、message、tool、reasoning 等源码，并与本地调用链、contracts 和测试定义交叉核对。
- CodeGraph 可用，已用于初始符号/调用关系排查；针对未返回源码的部分做了定向读取。
- 本机当前 shell 的 Node 是 v22.13.1；发现的 nvm 目录只列出 v22.13.1。本轮没有在不符合仓库要求的 Node 下运行项目命令、测试或安装。
- 读取现有开发日志得到 web 地址 `http://127.0.0.1:58933`，浏览器打开报 `ERR_CONNECTION_REFUSED`。因此未完成当前 UI 视觉复现、真实性能测量或上传/队列端到端验证。
- 上述缺口中，可见上传错误、事件/组件边界、文件限制和状态差异有直接源码依据；拥挤程度、滚动手感及采用后的性能改善仍需实施前后浏览器验证。
- 本轮仅新增本规划文档；没有覆盖已有 DESIGN.md、聊天或 daemon 的未提交修改。
