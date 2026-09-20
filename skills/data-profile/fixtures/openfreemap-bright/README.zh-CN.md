# OpenFreeMap bright Skill fixture

[English](README.md) | 中文

本目录存放 `data-profile` Skill 的非规范测试数据。它不是 cartography.md
核心示例，不是 `CARTOGRAPHY.md` 契约，也不表示其中的 profile 已通过核心验证。

fixture 使用公开的 [OpenFreeMap bright](https://tiles.openfreemap.org/styles/bright)
生产样式（OpenMapTiles 底图）。集成测试只读取本地样式，不获取 TileJSON、
矢量瓦片、字体或 sprite，也不需要实时网络访问。

## 确定性 profile

`DATA_PROFILE.json` 是固定时间戳的样式发现输出：

```bash
pnpm --filter @cartographymd/data-profile-skill profile -- \
  --style skills/data-profile/fixtures/openfreemap-bright/style.json \
  --observed-at 2026-08-29T00:00:00Z \
  --output skills/data-profile/fixtures/openfreemap-bright/DATA_PROFILE.json
```

请从仓库根目录运行该命令。所有相对 CLI 路径都以原始调用目录解析，而不是以私有
package 目录解析。由于此次运行只观察样式，证据均为
`style-inferred`；字段域与实际瓦片内容仍作为明确的 unresolved 项保留。提交的
输出是测试所用的预期 fixture，并不声称完整描述了 OpenMapTiles 数据。

## 文件

- `style.json` —— 作为发现输入保留在本地的 OpenFreeMap bright 样式；
- `DATA_PROFILE.json` —— `tests/openfreemap.test.ts` 使用的确定性预期输出；
- `THIRD_PARTY_LICENSES.md` 与 `THIRD_PARTY_LICENSES.zh-CN.md` —— 与样式放在一起的许可及署名说明。

实际渲染该样式仍需访问 `tiles.openfreemap.org` 获取瓦片、字体与 sprite；
fixture 测试不会渲染样式。

## 许可

`style.json` 是 OpenFreeMap / OSM Bright 的上游作品，本项目以修改副本形式再分发，适用 MIT（OpenFreeMap）、
BSD-3-Clause（样式代码）与 CC BY 4.0（样式设计）。详见
[THIRD_PARTY_LICENSES.zh-CN.md](THIRD_PARTY_LICENSES.zh-CN.md)（[English](THIRD_PARTY_LICENSES.md)）。
