---
version: "0.4.0"
name: "莫奈风格"
description: "以莫奈绘画中的柔和光色、空气感和层叠笔触为启发的可复用地图视觉规范。"
colors:
  canvas: "#F4EBDD"
  land: "#E8DCC8"
  water: "#A9C9C5"
  water-deep: "#78A9A8"
  vegetation: "#AFC39C"
  vegetation-deep: "#7F9F82"
  building: "#D9B8A5"
  building-light: "#E8CDB9"
  road: "#D5A77E"
  road-primary: "#B9785F"
  ink: "#435A59"
  ink-soft: "#6D7F78"
  highlight: "#F2C98E"
  white: "#FFF9EF"
typography:
  place:
    fontFamily: ["Georgia", "serif"]
    fontSize: "14px"
    fontWeight: "bold"
    lineHeight: 1.2
  secondary:
    fontFamily: ["Georgia", "serif"]
    fontSize: "12px"
    lineHeight: 1.2
  annotation:
    fontFamily: ["Arial", "sans-serif"]
    fontSize: "11px"
    lineHeight: 1.2
widths:
  hairline: "0.75px"
  local-road: "1.25px"
  secondary-road: "2px"
  primary-road: "3px"
  water-edge: "1px"
  label-halo: "2px"
sizes:
  poi: "8px"
  landmark: "11px"
opacities:
  muted: 0.72
  soft: 0.84
  solid: 1
spacing:
  label: "3px"
  poi: "2px"
dashes:
  path: ["4px", "3px"]
elements:
  background-canvas:
    geometry: "background"
    family: "canvas"
    role: "地图底色"
    layerRole: "底图背景"
    fillColor: "{colors.canvas}"
  land-base:
    geometry: "polygon"
    family: "land"
    role: "陆地底色"
    layerRole: "基础面"
    fillColor: "{colors.land}"
    opacity: "{opacities.solid}"
  water-lake:
    geometry: "polygon"
    family: "water"
    role: "湖泊与静水面"
    layerRole: "水系面"
    fillColor: "{colors.water}"
    strokeColor: "{colors.water-deep}"
    strokeWidth: "{widths.water-edge}"
  water-river:
    geometry: "line"
    family: "water"
    role: "河流与连续水体"
    layerRole: "水系线"
    strokeColor: "{colors.water-deep}"
    strokeWidth: "{widths.water-edge}"
  landuse-vegetation:
    geometry: "polygon"
    family: "vegetation"
    role: "公园、林地与绿地"
    layerRole: "自然面"
    fillColor: "{colors.vegetation}"
    outlineColor: "{colors.vegetation-deep}"
    outlineWidth: "{widths.hairline}"
    opacity: "{opacities.soft}"
  building-residential:
    geometry: "polygon"
    family: "building"
    role: "居住建筑"
    layerRole: "建筑面"
    fillColor: "{colors.building-light}"
    outlineColor: "{colors.building}"
    outlineWidth: "{widths.hairline}"
    opacity: "{opacities.soft}"
  building-public:
    geometry: "polygon"
    family: "building"
    role: "公共建筑与地标建筑"
    layerRole: "建筑面"
    fillColor: "{colors.building}"
    outlineColor: "{colors.ink-soft}"
    outlineWidth: "{widths.hairline}"
  road-local:
    geometry: "line"
    family: "road"
    role: "支路与街巷"
    layerRole: "交通线"
    strokeColor: "{colors.road}"
    strokeWidth: "{widths.local-road}"
    opacity: "{opacities.soft}"
  road-secondary:
    geometry: "line"
    family: "road"
    role: "次干道"
    layerRole: "交通线"
    strokeColor: "{colors.road}"
    strokeWidth: "{widths.secondary-road}"
  road-primary:
    geometry: "line"
    family: "road"
    role: "主要道路"
    layerRole: "交通线"
    casingColor: "{colors.white}"
    casingWidth: "{widths.primary-road}"
    strokeColor: "{colors.road-primary}"
    strokeWidth: "{widths.secondary-road}"
  road-path:
    geometry: "line"
    family: "road"
    role: "步道与非机动车路径"
    layerRole: "慢行线"
    strokeColor: "{colors.vegetation-deep}"
    strokeWidth: "{widths.hairline}"
    dash: "{dashes.path}"
  road-bridge:
    geometry: "line"
    family: "road"
    role: "桥梁"
    layerRole: "交通线"
    casingColor: "{colors.white}"
    casingWidth: "{widths.primary-road}"
    strokeColor: "{colors.road-primary}"
    strokeWidth: "{widths.secondary-road}"
  poi-landmark:
    geometry: "point"
    family: "poi"
    role: "重要地标"
    layerRole: "兴趣点"
    color: "{colors.highlight}"
    size: "{sizes.landmark}"
    symbol: "圆点"
  poi-general:
    geometry: "point"
    family: "poi"
    role: "一般兴趣点"
    layerRole: "兴趣点"
    color: "{colors.ink-soft}"
    size: "{sizes.poi}"
    symbol: "圆点"
  label-place:
    geometry: "label"
    family: "label"
    role: "地点名称"
    layerRole: "文字标注"
    color: "{colors.ink}"
    typography: "{typography.place}"
    haloColor: "{colors.canvas}"
    haloWidth: "{widths.label-halo}"
    spacing: "{spacing.label}"
  label-secondary:
    geometry: "label"
    family: "label"
    role: "次要说明文字"
    layerRole: "文字标注"
    color: "{colors.ink-soft}"
    typography: "{typography.secondary}"
    haloColor: "{colors.canvas}"
    haloWidth: "{widths.label-halo}"
    spacing: "{spacing.label}"
---

## Overview

本规范以莫奈作品中常见的柔和互补色、受光面变化和开放空气感为视觉启发。地图应保持低对比、温暖而有层次的整体气质，同时确保道路、水系、建筑和文字仍能被识别。

本文档是稳定的视觉指导，不包含数据源、字段、过滤器、图层 ID、运行时绑定或目标渲染器配置。原始样式文件未提供，因此文中的颜色、符号和比例规则属于设计建议，不是从来源样式提取的事实。

## Colors

背景与陆地使用米色系，水系使用蓝绿色，植被使用低饱和绿色，建筑使用暖粉褐色，道路使用赭石色，文字使用蓝灰色。高亮色仅用于重要地标或需要强调的语义，不应成为大面积底色。

颜色的语义优先于装饰：水体、植被和建筑应保持稳定色相；同一语义在不同尺度上可改变面积、透明度或细节，但不应任意换色。透明度只用于减弱次要内容，不能使关键边界消失。

## Typography & Labels

地点名称使用衬线字体以保留绘画般的人文气质，次要说明可降低字号和对比度。字体回退顺序必须由目标环境实际可用字体决定；本文件未验证任何具体字体安装情况。

标签应有柔和的背景光晕，避免直接使用纯黑描边。重要地点优先于次要地点，标签之间应保持明确的避让关系。标签字号、字重和间距应随语义层级变化，不应仅按几何类型统一处理。

## Composition & Density

画面应保留呼吸空间，避免把所有数据都以同等强度呈现。背景、陆地和自然面构成低对比底层，道路和地标承担方向与定位功能，文字只在有足够空间时出现。

当要素密度升高时，优先减少次要标签和装饰性点位，再降低次要面的透明度；不要同时压缩文字、道路和关键边界。局部拥挤区域可采用聚合、抽稀或标签避让，但具体算法属于运行时或目标渲染器职责。

## Layering & Depth

建议从后到前排列为：地图背景、陆地底色、水系与植被、建筑、道路、兴趣点、标签。水系边缘应清晰但不过度突出；主要道路可通过浅色 casing 与赭石色中心线建立层次。

语义状态优先于交互反馈，交互反馈优先于装饰。选中状态不得覆盖关键语义，悬停不得抹除选中或警示含义。本文未定义具体选中、悬停、禁用或告警 token；目标产品需要这些状态时，应在运行时以不改变基础语义的方式补充。

## Geometry & Symbols

面要素使用柔和填色与细边界，线要素使用有限的宽度层级，点要素使用圆点保持简洁。桥梁使用浅色 casing 与道路中心线组合，以表达跨越关系；步道使用短划线，但不得与水系线混淆。

尺寸表示旋转前几何主体的长边；圆点使用直径。casing、outline 和 halo 的宽度分别按各自每侧厚度理解。偏移和间距应以目标渲染器的正方向约定为准，本文件不假设具体坐标或像素方向。

## Scale & Generalization

本规范只定义相对层级，不提供未经验证的目标缩放级别。可按以下阶段应用：远景优先保留背景、水系、主要道路和重要地标；中景加入主要建筑、次干道和地点名称；近景再加入支路、步道、一般兴趣点及次要说明文字。

缩小时应先移除细小点位、次要标签和局部建筑细节，再降低自然面边界的存在感；不要通过单纯缩小所有尺寸来代替概括。放大时可恢复已声明的层级，但不得自动推断未声明的语义。

具体最小显示尺度、最小线长、标签冲突阈值、聚合半径和瓦片缩放范围均未提供，需结合目标数据、渲染器和实际浏览器结果验证。

## Map Elements

推荐元素边界如下：background-canvas 仅负责画布底色；land-base 负责陆地基础面；water-lake 与 water-river 负责静水面和连续水系；landuse-vegetation 负责自然面；building-residential 与 building-public 区分一般建筑和公共建筑；road-* 负责道路层级；poi-* 负责点状兴趣点；label-* 负责文字层级。

这些元素是可复用的视觉组件，不是数据绑定声明。元素名称不能替代数据分类；只有当实际数据的几何类型和语义都匹配时，才可在外部绑定到它们。

## Do's and Don'ts

Do：保持低饱和暖色与蓝绿色水系的稳定关系；使用少量高亮色建立视觉焦点；让道路、文字和水系边界承担清晰的信息层级；在缩放时按语义概括；验证目标渲染器对透明度、字体、描边和虚线的支持。

Don't：不要把所有要素画成同等对比度；不要用纯黑描边破坏柔和气质；不要用颜色单独表达唯一关键含义；不要把运行时字段、过滤器、图层 ID 或数据源写入本规范；不要把未经来源证据支持的样式描述为提取结果；不要在缺少几何和核心样式属性时创建绑定。

未提供原始样式证据、运行时数据画像和目标渲染器，因此尚未确认具体数据分类、字体可用性、比例阈值或渲染等价性。
