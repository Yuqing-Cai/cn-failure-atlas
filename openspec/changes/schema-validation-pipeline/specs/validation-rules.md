# Spec: Validation Rules

> 历史说明：这是 v1 规格快照。v2 的可执行规则已经升级为完整 Draft 2020-12 校验、分类型计数、衍生图环检测和严格文档同步；当前契约以根目录 Schema、`validate.js` 与负例测试为准。

## R1 — JSON Schema 合规

- taxonomy.json 必须通过 taxonomy.schema.json 验证
- 使用 Ajv（JSON Schema draft-2020-12 唯一需要的外部依赖，或内联简化验证）
- 决定：用 Node.js 手写校验，避免引入 Ajv。schema 结构固定且简单，手写更轻量

## R2 — total_labels 计数一致

- `total_labels` 值 = 所有 layers 中所有 subcategories 中所有 labels 的数量 + underlying_tendencies 数量 + cross_layer_tags 数量
- 报告：期望值 vs 实际值

## R3 — 标签 ID 全局唯一

- 收集所有 label.id + tendency.id + cross_layer_tag.id
- 任何重复 → 报错并列出重复 ID 及其位置

## R4 — derived_from 引用完整性

- 每个 label 的 `derived_from`（非 null 时）必须指向一个存在的 label ID
- 自引用 → 报错
- 指向不存在的 ID → 报错

## R5 — subcategory ID 前缀匹配

- subcategory.id 格式应为 `{layer.id}-{letter}`
- 例：layer "III" 下的 subcategory 应以 "III-" 开头

## R6 — Markdown ↔ JSON 标签同步

- 解析 layers/*.md，提取反引号中的 snake_case 标签 ID（如 `` `emotion_misread` ``）
- 与 taxonomy.json 中对应层的标签 ID 集合做双向 diff
- JSON 有但 Markdown 没提到 → warning（可能是新加标签还没更新文档）
- Markdown 提到但 JSON 没有 → error（引用了不存在的标签）

## R7 — tendency.primary_layer 有效性

- 每个 tendency 的 `primary_layer` 值必须是已有 layer.id 之一，或形如 "II-III"（跨层范围）
- 跨层范围中的每个部分都必须是有效 layer ID
