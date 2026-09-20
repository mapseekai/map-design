# 第三方许可说明（openfreemap-bright 示例）

[English](THIRD_PARTY_LICENSES.md) | 中文

本目录中的 `style.json` 是 [OpenFreeMap bright 样式](https://tiles.openfreemap.org/styles/bright)的修改副本，源自
[hyperknot/openfreemap-styles](https://github.com/hyperknot/openfreemap-styles) 项目。本项目仅添加了
cartography.md 治理 metadata，并将三处旧式 filter 表达式升级为表达式语法；所有绘制值、图层与设计决策均来自上游。

## OpenFreeMap（样式托管与工具链）

MIT 许可证，Copyright (c) 2023 Zsolt Ero。

> 免费授予任何获得本软件副本的人使用、复制、修改、合并、发布、分发、再许可及销售软件副本的权利，前提是在所有副本或实质部分中包含上述版权声明与本许可声明。
> 软件按"原样"提供，不附带任何明示或默示的担保。完整英文文本见上文英文版。

来源：[openfreemap/LICENSE.md](https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md)

## Bright 样式

Bright 是 [openmaptiles/osm-bright-gl-style](https://github.com/openmaptiles/osm-bright-gl-style)
的分支，后者衍生自 [Mapbox Open Styles](https://github.com/mapbox/mapbox-gl-styles)。

- 样式代码：[BSD 3-Clause 许可证](https://github.com/openmaptiles/osm-bright-gl-style/blob/master/LICENSE.md)
- 样式设计：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## 样式渲染所用的数据与资源

- 矢量瓦片与地图数据：[OpenStreetMap](https://www.openstreetmap.org/copyright) 数据，© OpenStreetMap 贡献者（ODbL）。
- 低 zoom 山体阴影栅格：[Natural Earth](https://www.naturalearthdata.com/) 数据，公共领域。
- 标注字体：[Noto Sans](https://fonts.google.com/noto)，SIL Open Font License 1.1。
- POI 图标：[Maki 图标集](https://github.com/mapbox/maki/blob/master/LICENSE.txt)，CC0 1.0。

瓦片、字体与 sprite 服务由 OpenFreeMap（`tiles.openfreemap.org`）运营；渲染本示例需要访问这些服务。
