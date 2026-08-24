# v1 → v2 迁移说明

[← 返回项目首页](../README.md)

v2 是一次有意的破坏性本体升级：它不再把可观察症状、因果解释、复合现象和不确定性记录都叫作“标签”。所有原有症状 ID 保持不变。

| v1 | v2 | 原因 |
|---|---|---|
| `total_labels` | `total_items` + `item_counts` | 避免把不同认识论类型混算成同类标签 |
| `confidence_level` | `observability` | 旧值描述的是预期可观察难度，不是一次标注的实测置信度 |
| `underlying_tendencies` | `causal_hypotheses` | 因果归因必须保持可证伪，不能冒充模型内部事实 |
| `cross_layer_tags` | `composite_tags` + `uncertainty_markers` | `supportive_but_wrong` 与 `reading_preservation_hybrid` 的用途不同 |
| Layer IV-B：8 项 | IV-B：5 项 + IV-C：3 项 | 修正文档已经表达、JSON 却未落实的子类漂移 |

另外：

- `schema_version`、`taxonomy_version`、`status` 与 `updated_at` 成为必填字段；
- `diagnostic_order` 明确进入数据契约；
- JSON Schema 改为 Ajv Draft 2020-12 全量执行，不再只是局部手写检查；
- `derived_from` 新增环检测；
- 机器演化记录使用 `schemas/` 下的独立 1.0.0 Schema；
- 人工标注指南继续可用，但不再是纯机器演化的必经环节。

如果程序只消费 70 个可观察症状，应遍历 `layers[].subcategories[].labels[]`。如果需要完整 78 项，再显式合并另外三种类型；不要把因果假设直接当作输出中已经观察到的失败。
