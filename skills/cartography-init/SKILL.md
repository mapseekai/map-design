---
name: cartography-init
description: Use when the user wants to convert an existing map style (style.json, .qgs/.qgz, .lyrx/.stylx, .sld) into a CARTOGRAPHY.md draft while keeping runtime data bindings outside the document.
---

# 从既有样式初始化 CARTOGRAPHY.md

将已有地图样式转换为可继续编辑的 CARTOGRAPHY.md 草稿，并把无法成为持久设计规则的运行时细节明确分诊。生成结果不是已完成的迁移：必须完成报告中的补写和分诊后，才可以宣称迁移完成。

## 触发与不触发

在用户提供或指定既有 `style.json`、QGIS `.qgs`/`.qgz`、ArcGIS `.lyrx`/`.stylx`、或 SLD `.sld` 样式，并要求转换、迁移、初始化或提取为 CARTOGRAPHY.md 时使用本技能。

不要用于从零创作、重设计地图语言、或直接编辑已有 CARTOGRAPHY.md 的持久设计决策；这些任务使用 `cartography-md` 技能。不要把初始化器当作数据探测器：数据集、瓦片字段和值域的运行时事实由 `data-profile` 处理。

## 命令

从仓库根目录运行。显式写出全部产物，便于审阅和复现：

```bash
pnpm --filter @cartographymd/init-skill init -- \
  --input path/to/style.json \
  --output CARTOGRAPHY.md \
  --report INIT_REPORT.md \
  --report-json INIT_REPORT.json
```

可用 `--name "地图名称"` 覆盖草稿名称。支持的输入格式由文件内容和扩展名识别：`style.json`、`.qgs`、`.qgz`、`.lyrx`、`.stylx`、`.sld`。

未指定名称时使用中性占位名 Imported cartographic design；输入文件名保留在报告中，不充当设计系统名称。

检查已完成分诊的报告：

```bash
pnpm --filter @cartographymd/init-skill init -- \
  --check-report INIT_REPORT.json
```

退出码：`0` 表示生成成功或报告全部完成分诊；`1` 表示验证失败或仍有未分诊 bindings；`2` 表示参数、读取、解析或报告格式错误。

## 工作流

1. **生成**：执行初始化命令，保留 `CARTOGRAPHY.md`、人类可读的 `INIT_REPORT.md` 和机器可读的 `INIT_REPORT.json`。先阅读报告中的 `skipped`、`datasources`、`bindings`、`unresolved` 与后续清单。
2. **读报告**：把转换器提取的内容视为证据而非最终设计。确认每个元素是否具有稳定、面向设计的意义；检查 `skipped` 是否需要人工重建，`unresolved` 是否阻塞使用。
3. **补写草稿**：在 CARTOGRAPHY.md 中补全语义命名、设计意图和必要的 `TODO(agent)` 段落。描述视觉角色、层级、缩放行为和可访问的设计选择，而不是样式源的数据实现。
4. **bindings 分诊**：逐条编辑 `INIT_REPORT.json` 的 `bindings`，在对应项写入 `triage` 决定。每个 binding 必须选择下表三者之一；不要删除原始证据，也不要把 binding 复制进文档。
5. **检查报告**：运行 `init -- --check-report INIT_REPORT.json`。若退出码为 1，回到分诊步骤；报告没有未决定项前不得继续宣称完成。
6. **验证文档**：运行 `cartographymd lint CARTOGRAPHY.md`。仅在报告分诊通过且 lint 通过后，交付该草稿及其已知未决项。

## bindings 分诊决策表

| 决定 | 标准 | 示例 |
|---|---|---|
| 设计意图 prose | binding 反映跨数据源仍成立的视觉目标，可用不含字段或过滤表达式的自然语言保留 | `class=primary` 驱动更粗道路，可写成“主干道路比普通道路更醒目”，不写 `class` 或表达式 |
| 运行时保留 | binding 是部署时数据契约，必须由应用、样式或 DATA_PROFILE 管理，不能成为持久设计规则 | `population > 100000` 的阈值或 `source-layer` 绑定，保留在运行时配置/数据资料，不进入文档 |
| 显式丢弃 | binding 只是历史样式的偶然细节、无效条件或不再需要的实现噪音 | 旧供应商字段 `legacy_rank` 的过时过滤条件，记录丢弃原因后不迁移 |

## 限制

- 0.4.0 草稿默认保留完整九章，以 Do's and Don'ts 结束；Data & Legend 只能作为附加章节。
- 来源、提取统计、跳过项、具体 zoom/比例尺和转换证据只进入两份 INIT_REPORT。缺少设计意图时保留 TODO(agent)，不得编造理由。
- 核查 widths / sizes / spacing 分组；offset 保持字面值或扩展，明确非零偏移参照、方向和正负含义。size 是旋转前主体包围盒长边（圆形直径）；casingWidth 是每侧厚度。目标不等价时报告替代和损失。
- 不按 family 数量、排列、名称后缀或颜色推断 role/state；无证据时省略。组合状态必须显式定义，语义状态优先于操作反馈。
- 相同数值只是共享 Token 候选，不是语义等价证据。审查报告中的候选后才确认共享；Typography 比较全部核心字段，并保留未知扩展。
- 补写尺度基础阶段、允许变化与不变量，保留精确 Token 定义。只为当前目标所作适配不得自动变成永久组件。
- 格式校验、设计评审、目标验证和视觉评审分别报告；lint 通过不能替代后三者。

- 数据绑定绝不进入 CARTOGRAPHY.md：不得写入 `source-layer`、字段名、过滤表达式、数据画像或其他运行时数据契约。
- 不支持的 CIM 或符号层必须保留在报告的 `skipped` 中；不要伪造等价设计或静默吞掉它们。
- 初始化产物是草稿，不是成品。完成语义补写、设计意图、TODO(agent)、bindings 分诊、报告检查与 lint 之前，绝不宣称迁移完成。
- `datasources` 和 `bindings` 是追溯证据，不是文档内容。需要运行时事实时，使用 `data-profile`，且不要反向改写 CARTOGRAPHY.md 以迎合数据。

## MapDesign integration

In this repository, run document lint with `pnpm --filter @mapseekai/daemon exec cartographymd lint /absolute/path/to/CARTOGRAPHY.md`. Use absolute document paths because the command runs in the daemon package directory. The CARTOGRAPHY.md manager creates reviewable drafts; format validation does not imply completed design review or bindings triage.
