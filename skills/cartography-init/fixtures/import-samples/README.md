# 真实样式导入样例

最初四份文件由用户提供，2026-09-29 从本机下载目录原样复制，用于手动导入演示和自动回归测试。保留原文件名及内容；来源文件的版权与许可归原权利人，本目录不另行授予许可。2026-09-30 新增的 QGIS 官方工程采用下文单独标明的原许可。

| 文件 | 大小 | 回归场景 | 当前提取结果 |
| --- | ---: | --- | --- |
| `OSM Simple Light.lyrx` | 434892 字节 | ArcGIS HSL 颜色导致空样式元素 | 38 个元素、44 个颜色项 |
| `style-example.sld` | 5156 字节 | Categorize 动态填色、不完整字体定义 | 3 个元素、9 个颜色项、3 条跳过说明 |
| `OS GeoDataViz Colours & Symbols (ArcPro)_v2.stylx` | 86016 字节 | 自定义分类、固定色带、JSON 末尾空字符 | 22 组色带、125 个颜色项，无地图几何元素 |

## 使用

在“设计规范 → 添加规范 → 从样式创建”中选择文件，填写规范名称，然后生成草稿。检查 `CARTOGRAPHY.md` 和 `INIT_REPORT.md` 后再保存。

SLD 保留动态表达式中的颜色字面量，具体动态规则和缺少字体的标注需要补全；不会凭空生成静态样式。该原文件存在嵌套 XML 注释，当前宽松解析器的提取结果也记录在回归测试中，不应将它当作标准 SLD 模板。

STYLX 的全部 22 个条目实际为固定色带。没有几何元素是正常结果，颜色名称带有色带名和原始顺序。

## 自动测试

使用 Node 24 和项目要求的 pnpm 版本：

```sh
pnpm --filter @cartographymd/init-skill exec vitest run tests/import-samples.test.ts
```

测试直接读取这些文件，经完整转换流程生成并校验文档，检查提取数量及关键颜色、表达式和跳过报告。

## MapLibre / Mapbox v8 样式

`style-v8.json`（23277 字节）同样由用户提供并原样复制，包含 48 个图层。当前转换得到 48 个元素、55 个颜色项和 46 条跳过说明。其旧式 `stops` 缩放函数及部分动态虚线参数没有转换成静态值，原表达式保留在 INIT_REPORT.json 中。导入设计规范不需要请求原文件引用的瓦片、字体和精灵服务。

## QGIS 官方真实工程

两份工程来自 QGIS 官方仓库的实际测试工程，原始字节完整保留（仅调整本目录文件名），不是针对本适配器编造的最小 XML。固定来源提交为 `20dc5867eb89838f87b789ad4c4c9f07575009b8`。

| 文件 | 大小 | 回归场景 | 当前实际提取结果 |
| --- | ---: | --- | --- |
| `qgis-quickapp.qgs` | 43779 字节 | 3 个分类渲染图层、旧版 `prop` 属性、SVG 标记、RGBA 透明色、毫米单位 | 4 个元素、6 个颜色项、19 条跳过说明 |
| `qgis-selective-masking.qgs` | 234251 字节 | 7 个图层、分类渲染、两层线符号、MarkerLine/SVG、普通和规则式标注、文字遮罩、MM/Point 单位、栅格渲染器 | 9 个元素、9 个颜色项、61 条跳过说明 |

### 来源、校验与许可

- QuickApp：[固定原文件](https://raw.githubusercontent.com/qgis/QGIS/20dc5867eb89838f87b789ad4c4c9f07575009b8/tests/testdata/quickapp_project.qgs)。SHA-256：`f1a7c68cdd5de3e5061f3e589db34893316a472ca85b10f7563315c1f8b84c3b`。
- Selective Masking：[固定原文件](https://raw.githubusercontent.com/qgis/QGIS/20dc5867eb89838f87b789ad4c4c9f07575009b8/tests/testdata/selective_masking.qgs)。SHA-256：`b0a3f607a59ffaabc2f40ff9b083c91196bedba86975a7f3fb86a2f130ebdba1`。
- 原作者/来源：QGIS Development Team 与 QGIS 项目贡献者；Selective Masking 工程原始保存信息为 Julien Cabieces，信息保留在文件中。
- 两份工程按 QGIS 仓库的 [COPYING](https://github.com/qgis/QGIS/blob/20dc5867eb89838f87b789ad4c4c9f07575009b8/COPYING) 分发，完整原文随附为 `QGIS-COPYING`（GNU GPL v2，含 QGIS 附加说明）。它们作为独立测试数据保留原许可，不重新许可为本仓库许可证。QGS 即原始可编辑 XML；本次没有提交二进制或工程引用的数据、SVG、字体。

测试固定输入 SHA-256、完整适配器 IR、完整 JSON 报告，以及生成草稿的 SHA-256。`*.qgs.baseline.json` 是经过检查的提取事实，不由测试自动更新；修改适配器后应逐项审查差异，再更新基线。相同真实工程另经 ZIP 打包走完整 `.qgz` 导入路径，检查其结果与 `.qgs` 相同；该打包检查不冒充上游原生 QGZ 样例。

### 基线含义与报告

当前多层线符号按原顺序覆盖核心属性，例如黑色 `3.26mm` 加黄色 `1.86mm` 的两层线，输出元素保持黄色 `1.86mm`；原始两层颜色和宽度仍在 IR/Token 基线中，叠加语义进入 skipped。分类字段/条件、未转换的符号属性（含线型）、SVG、MarkerLine、栅格渲染器同样有明确跳过说明。

Selective Masking 保留 `Sans` 与 `16pt/10pt/32pt` 字号的当前提取结果。标注文字颜色、字段、buffer/mask/background/shadow/placement、规则式标注条件及额外 text-style 进入 skipped/report；`labelsEnabled=0` 的标注仍按现有提取逻辑生成，并在报告中明确指出启用状态尚未应用。QuickApp 的 `labelsEnabled=1` 没有相应 labeling 设置，也明确记录。报告 detail 是最多 200 字符的原始片段摘要，完整原值可在哈希固定的工程 XML 中追溯。

这些回归验证的是“实际提取事实 + 明确的转换边界”，不代表 QGIS 画面的完整视觉复现。测试只读取工程样式，不请求工程里的相对路径、WMS/瓦片或字体服务。
