# v1 → v2 迁移说明

[← 返回项目首页](../README.md)

v2 把原来统称为“标签”的内容拆成四种认识论类型：可观察症状、因果假设、复合现象和不确定性记录。70 个原有症状 ID 保持不变。

## 一、本体变化

| v1 | v2 | 变化 |
|---|---|---|
| `total_labels` | `total_items` + `item_counts` | 分开统计四类对象 |
| `confidence_level` | `observability` | 表示预期可观察难度，而非一次标注的实测置信度 |
| `underlying_tendencies` | `causal_hypotheses` | 把因果归因保留为可证伪假设 |
| `cross_layer_tags` | `composite_tags` + `uncertainty_markers` | 分开承载 `supportive_but_wrong` 与 `reading_preservation_hybrid` |
| Layer IV-B：8 项 | IV-B：5 项 + IV-C：3 项 | JSON 与文档中的子类划分现已一致 |

`schema_version`、`taxonomy_version`、`status` 与 `updated_at` 现在必填，`diagnostic_order` 也进入数据契约。当前 taxonomy 版本为 `2.0.0-alpha.2`，JSON Schema 由 Ajv Draft 2020-12 全量执行。

关系语义也已收紧：

- `derived_from` 只表达严格子型，并接受环检测；
- 普通关联进入类型化 `related_to`；
- `derived_from`、`related_to` 与 `confusable_with` 在规范 JSON 中都是有向边，消费端不能凭自然语言上的对称感自动补反向边；
- `confusable_with` 表示“从当前症状出发需要排除谁”，空数组表示该方向的近邻尚未冻结；
- 症状新增 `minimum_evidence_scope`、`confusable_with`、`discriminating_tests` 和 `discriminating_test_status`。目前 23 个症状的区分测试为 `specified`，47 个为 `underspecified`；后者保持空缺，等待逐项边界证据。

## 二、证据与因果边界

evidence span 统一使用可重放的 Unicode code-point 半开区间，并成为必填字段。diagnostic subject 还须列出 `generator_output_turn_id(s)`、turn→scene 映射，以及各 scene 的完整内嵌契约。

`contract_digest` 从内嵌契约重算；主 scene 契约与顶层 `scene_contract` 必须一致。

自然语言 `discriminating_tests` 服务于人工审阅和 recipe 设计。机器结果有更严格的入口：症状带结构化 `test_recipes`，且列入 `machine_execution_policy.executable_symptom_ids`，才能生成 finding 级 `taxonomy_test_results` 并进入晋升。

`neighboring_label_rebuttals` 只排除或确认真实近邻；`confusable_with: []` 时无需虚构邻居。rebuttal 和测试结果只能引用本 finding 的证据。

因果假设改为独立证据组计数：

- 每个假设带 `support_contract.status`、`admissible_symptom_ids` 和 `match_mode`；
- `underspecified` 不能由机器标为 `present`；`exact` 接受白名单中的精确 ID，`descendants_included` 还接受其严格子型；
- 父子标签或复用同一、重叠正向 evidence span 的标签只算一组；
- 判断理由相同但 span 不重叠的情况，当前 Schema 还不能机器识别；
- 因果 finding 的 `status: present` 表示达到受支持假设的提案门槛，不表示模型内部原因已被观察或证明。

## 三、机器演化记录

机器记录使用 `schemas/` 下的 `2.0.0-alpha.1` 契约。v2 加入 policy digest、实验账本、类型化晋升工件与冻结的 `evaluation_manifest`。

`promotion_target` 迁移为带 payload、source ref 和内容摘要的 `promotion_artifact`。当前 Gate 执行案例级 `repair_case`；`repair_strategy` 仍可表达，但在跨独立留出案例的 applicability manifest 落地前会返回未实现。

每项 repair edit 都绑定目标轮次、Unicode 区间、原文与替换文本；全部重放后须逐字得到候选。保留约束与冻结的 `hard_veto` regression 双向链接。

验证分为匿名偏好和目标审计两路：偏好 judge 看匿名候选，目标感知 audit judge 看 finding、证据与保留约束。A/B 映射在候选产生后、试验开始前用加盐承诺固定；每次调用都绑定请求、隔离上下文、派生 seed 与执行时间。

`repeat_manifest[].input_digest` 绑定共同冻结输入。每个 `run_digest` 只覆盖该 repeat 的 ID、seed、输入摘要、执行时间与 AB/BA `order_trials`；全局 evidence、counterfactual、regression 和 challenge 集合由上层完整性检查封存。

## 四、来源、信任与状态

跨记录引用升级为内容寻址引用，并由本地权威 Schema 的 ID/version 锚定；URI 负责链内定位一致性。

外部运行凭据现在有五个时间边界：生成前、诊断前、修复前、验证试验前和完成后。各阶段由 issuer 签名，生产签发器还要在外部持久化 `single_use_nonce`。这条签名链证明已登记承诺；若要证明 provider 只调用一次，还需 provider-signed receipt 或候选不可写的调用账本。

policy 中的 lifecycle 图使用精确 `condition_code` 转换。Gate 根据返回值核对 verification 的生命周期状态；策略应用、状态迁移和 rollback 仍由外部编排器执行。

人工标注指南继续服务于抽查与争议复核，纯机器运行不以人工记录为前置条件。

## 消费端怎么选

只消费 70 个可观察症状时，遍历 `layers[].subcategories[].labels[]`。需要完整 78 项时，再显式合并因果假设、复合现象和不确定性标记；因果假设不能当作输出中已观察到的失败。
