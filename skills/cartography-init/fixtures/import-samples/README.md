# 真实样式导入样例

最初四份文件由用户提供，2026-09-29 从本机下载目录原样复制，用于手动导入演示和自动回归测试。保留原文件名及内容；来源文件的版权与许可归原权利人，本目录不另行授予许可。

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


## QGIS 官方训练工程（2026-09-30）

以下两份文件来自 [QGIS/QGIS-Training-Data](https://github.com/qgis/QGIS-Training-Data)，用于真实工程格式回归；没有删减 XML，也没有在测试中重新打包 QGZ。固定上游提交为 `fd26dd88e39b9aec550eea450cec18d02b1de3b5`。

上游提供 [GNU GPL version 2](https://github.com/qgis/QGIS-Training-Data/blob/fd26dd88e39b9aec550eea450cec18d02b1de3b5/LICENSE.md)，许可副本为本目录的 [QGIS-Training-Data.LICENSE.txt](QGIS-Training-Data.LICENSE.txt)。这两份第三方工程及其归档内原有文件保留上游许可和作者信息，不另行授权；它们是独立测试数据，不是本项目代码的许可证声明。QGZ 是 QGIS 原生可编辑工程归档，包含 XML 和样式库，未包含可执行程序。

| 文件 / 固定原始地址 | 字节数 | 真实特性 | 当前回归基线 |
| --- | ---: | --- | --- |
| [selective_masking.qgs](https://raw.githubusercontent.com/qgis/QGIS-Training-Data/fd26dd88e39b9aec550eea450cec18d02b1de3b5/exercise_data/masking/selective_masking.qgs) | 127069 | QGIS 3.37；`Class` 分类、3 个 SvgMarker、双 SimpleLine、SimpleFill、Sans 标注、MM/Point、扩展 RGB 颜色 | 4 元素、4 颜色 token、13 skipped |
| [network.qgz](https://raw.githubusercontent.com/qgis/QGIS-Training-Data/fd26dd88e39b9aec550eea450cec18d02b1de3b5/exercise_data/network_analysis/network.qgz) | 14465 | QGIS 3.28.7；3 条 `RuleRenderer` 规则、双 SimpleLine 和 MarkerLine、点符号、`speed` 标注、MM/Point | 5 元素、8 颜色 token、16 skipped |

SHA-256（测试自动验证，`.gitattributes` 禁止这些原始文件的换行转换）：

```text
a43f23b25cd0e456bf49c23702aff456a928f8828b8abefa89f4170d2af80e8e  selective_masking.qgs
43cbad6404801e95dc2572423f815218c11975270d405ee2aa0a2c35363ca666  network.qgz
dba313854f65a8d41b1777cf9d6cb5ddf692792be04d808b82c86c63909fbdf0  QGIS-Training-Data.LICENSE.txt
```

### 基线含义与转换限制

- 统计来自完整 `initializeCartography` 流程，生成的文档通过 `verifyDocument`，并限制在 64 KiB 内。颜色数是生成的 token 数，不能当作不同 RGB 值的数量。
- 规则工程保留 `"direction" = 0/1/2` 过滤表达式；分类工程保留分类字段 `Class` 及 `B52`、`Biplane`、`Jet` 的值。`Heading`、`Name`、`speed` 标注字段进入 bindings，需要后续分诊，未变成静态标签内容。
- SimpleLine 多层叠加尚未等价转换：相同核心属性沿用最后一个可提取值，早期图层的颜色和宽度事实仍被收集，叠加限制进入 skipped。测试固定 `3.26/1.86mm` 及 `1.06/0.86mm`，避免只检测最后一层而遗漏外描边事实。
- `SvgMarker`、`MarkerLine` 不生成虚假的可用符号。分类工程的三个 SVG 符号被明确跳过；规则工程的四个 MarkerLine 也明确报告。
- 标注当前保留 Sans 和 `10pt/32pt` 字号；`text-buffer`、`text-mask`、文字颜色、排布等未映射配置均写入 skipped（报告包括默认或未启用设置，不表示这些效果全部处于启用状态）。`points` 的 `labelsEnabled=0` 也明确说明；现有导入语义保留配置定义，并不保证可见性一致。
- QGZ 原有 `ctLXeg_styles.db` 随归档原样保留，当前只读 `network.qgs`，附属样式库未读取也进入 skipped。
- 不随工程复制 shapefile、GeoPackage、SVG 等外部资源，也不访问工程中的 datasource。路径仅进入 report；这些样例验证样式提取，不保证在 QGIS 中直接打开后即可渲染完整地图。
- 不支持的渲染器、符号类型和嵌套规则会报告跳过。当前支持这里的平级 RuleRenderer 规则，不宣称支持全部 QGIS 功能。

### 离线回归与手动验证

工程和许可均已包含在仓库中，正常测试不需要网络、QGIS 安装或下载脚本。

```sh
pnpm --filter @cartographymd/init-skill exec vitest run tests/import-samples.test.ts tests/adapter-qgis.test.ts
pnpm --filter @cartographymd/init-skill init --input fixtures/import-samples/network.qgz --output /tmp/QGIS-CARTOGRAPHY.md --report /tmp/QGIS-INIT_REPORT.md --report-json /tmp/QGIS-INIT_REPORT.json
```

Windows 上请把 `/tmp/` 改为已存在的临时目录。替换样例时需一起核对固定提交、许可、原始 hash、属性断言和统计，不能只更新数量使测试通过。
