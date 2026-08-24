# Proposal: Schema Validation Pipeline

> 历史说明：本文记录 v1 验证器的原始提案。v2 已采用 Ajv 全量 Schema 校验，并以 `total_items` / `item_counts`、`causal_hypotheses`、`composite_tags` 和 `uncertainty_markers` 取代下文的旧数据契约；当前行为以根目录 `validate.js` 与测试为准。

## Why

cn-failure-atlas 有 78 个标签分布在 5 层 + 底层倾向 + 跨层标签中。随着分类体系持续演进（加标签、改定义、调整层级关系），纯手动维护会引入以下风险：

1. **结构回归** — taxonomy.json 违反 schema 约束但肉眼难发现（如 `confidence_level` 拼错、缺少必填字段）
2. **计数漂移** — `total_labels: 78` 和实际标签数不同步
3. **引用断裂** — `derived_from` 指向一个已改名或删除的标签 ID
4. **命名不一致** — subcategory ID 前缀与所属 layer ID 不匹配（如 layer "III" 下出现 "II-A"）
5. **Markdown-JSON 分裂** — layers/ 目录的 .md 文档和 taxonomy.json 中的标签列表不同步
6. **底层倾向悬空** — tendency 的 `primary_layer` 引用了不存在的层

## What

一个零依赖的 Node.js 验证脚本 `validate.js`，跑在 `npm run validate` 上，覆盖以上所有检查。失败时返回非零退出码，可接入 CI。

## Scope

- 只加验证工具，不改 taxonomy 数据结构
- 只用 Node.js 内置模块（fs, path, assert），不引入外部依赖
- 输出人类可读的中文错误信息
