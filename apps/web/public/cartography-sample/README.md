# Riverside — cartographic sample dataset

原创合成的虚构河畔城区，用于规范预览和渲染测试。坐标采用 WGS84（EPSG:4326），位于零度经纬线附近，仅为了保持米制近似，不代表真实地点。范围约 2.4 × 1.6 km。

## 文件

- riverside.geojson：61 个要素，含点、线、面与标注锚点。
- style.json：MapLibre GL JS 6.3 参考样式。色彩和线宽是演示样式，不是任何用户规范的推断结果。
- manifest.json：19 个语义分类及各自要素数量。

预览地址：/cartography-sample

## 稳定映射字段

每个要素有唯一 id，以及 name（中文）、name_en（英文）、geometry、family、role、match_key 和 synthetic 字段。

建议按 match_key 精确绑定规范，而不是按颜色、顺序或名称模糊猜测。geometry 是实际几何类型；label.* 是 Point 标注锚点，其规范侧几何语义应匹配 label。

- water.river / water.lake：河流面、湖泊面
- landuse.park：公园面
- building.residential / building.public：住宅与公共建筑面
- road.primary / secondary / local / bridge / path：分级道路、桥梁、步道线
- poi.museum / library / station / cafe / bus-stop / viewpoint：设施和兴趣点
- label.district / park / water：独立标注锚点

## 渲染约定

填充使用 fill 图层，道路使用 line 图层，点位使用 circle 图层，文字使用真正的 symbol 图层。参考样式配置了线状道路标注、点标注避让和随缩放变化的线宽、点大小。

MapLibre 6.3 在不配置 glyphs URL 时可使用本机字体生成文字，因此本示例不请求在线底图、瓦片或字体服务。字体外观仍取决于本机字体。

style.json 内的数据 URL 为 /cartography-sample/riverside.geojson。迁移到其他路径时调整该 URL，或将 FeatureCollection 直接嵌入 sources.sample.data。

点击预览页的文件名可下载。规范详情的「示例地图」按几何类型、family、role 和明确的要素名称匹配此数据，仅替换样式属性，不修改规范原文。相同优先级的多个候选会标为匹配不唯一；未匹配要素、未定义属性使用中性参考样式，未支持的属性在「要素对应」中列出。独立预览页仍展示本文件夹中的参考样式。
