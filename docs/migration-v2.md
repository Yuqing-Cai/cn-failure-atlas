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
- `derived_from` 只保留严格子型关系并增加环检测；普通关联迁入类型化 `related_to`。`derived_from`、`related_to` 与 `confusable_with` 在规范 JSON 中都是有向边；即使关系名称看似对称，也不会自动生成反向边；
- 症状新增 `minimum_evidence_scope`、`confusable_with` 与 `discriminating_tests`；`confusable_with` 表示“从当前症状出发必须排除谁”，空数组只表示当前版本尚未冻结该方向的近邻；
- 因果支持按独立证据组计数，父子标签或复用同一/重叠正向证据 span 的标签不能重复投票；“判断理由相同但 span 不重叠”尚无机器可验证字段；
- 每个因果假设新增 `support_contract.status`、`admissible_symptom_ids` 与 `match_mode`：`underspecified` 不得被机器标为 `present`，`descendants_included` 接受白名单症状的严格子型，`exact` 只接受精确 ID；
- 因果 finding 的 `status: present` 只表示达到当前支持假设的提案门槛，不表示已经观察或证明了模型内部原因；
- 机器演化记录使用 `schemas/` 下的 `2.0.0-alpha.1` 契约，并新增 policy digest、实验账本、类型化晋升工件与冻结 evaluation manifest；
- `promotion_target` 已迁移为带 payload、source ref 和内容摘要的 `promotion_artifact`；
- 当前可执行目标收窄为案例级 `repair_case`；旧的 `repair_strategy` 仍可表达，但在引入跨独立留出案例的 applicability manifest 前会被 Gate 明确判为未实现；
- evidence span 现在必填并统一为可重放的 Unicode code-point 半开区间；
- diagnostic subject 现在显式列出 `generator_output_turn_id(s)`、turn→scene 映射与每个 scene 的完整内嵌契约；`contract_digest` 必须从该契约重算，主 scene 契约还必须与顶层 `scene_contract` 一致；
- 只有带结构化 `test_recipes` 且列入 `machine_execution_policy.executable_symptom_ids` 的症状，才能把冻结区分检查写入 finding 级 `taxonomy_test_results`；自然语言 `discriminating_tests` 只是人工/设计提示。`neighboring_label_rebuttals` 只承担真实近邻的排除或共现判断，因此 `confusable_with: []` 的症状无需编造邻居；rebuttal 和测试结果只能引用本 finding 自己的证据；
- 跨记录引用升级为内容寻址引用，并由本地权威 Schema 的 ID/version 锚定；URI 只充当链内一致的定位符；
- 外部运行凭据升级为五阶段 issuer attestation：生成、诊断、修复、验证试验与完成各有独立时间边界和签名；生产签发器必须在外部持久化 `single_use_nonce`。它不单独证明 provider 只被调用一次；该强保证还需要 provider-signed receipt 或候选不可写的调用账本；
- 修复 edit 现在带 target turn、Unicode span、原文与 replacement，必须可重放为精确候选；保留约束必须双向链接冻结的 hard-veto regression；
- 偏好 judge 与目标感知 audit judge 分离；A/B 映射使用候选后、试验前签发的加盐承诺，每个 preference/audit invocation 都绑定具体请求、独立 context、确定性派生 seed 与执行时间；
- `repeat_manifest[].input_digest` 绑定共同冻结输入；每个 `run_digest` 只绑定该 repeat 的 ID、seed、输入摘要、执行时间和其 AB/BA `order_trials`，不代表该 repeat 单独封存了全局 evidence、counterfactual、regression 或 challenge 集合；
- policy 中的 lifecycle 图已冻结为 exact `condition_code` 转换，verification 的生命周期状态由 Gate 返回值确定性映射；仓库仍不会自动应用策略、迁移状态或执行回滚；
- 人工标注指南继续可用，但不再是纯机器演化的必经环节。

如果程序只消费 70 个可观察症状，应遍历 `layers[].subcategories[].labels[]`。如果需要完整 78 项，再显式合并另外三种类型；不要把因果假设直接当作输出中已经观察到的失败。
