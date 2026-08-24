# 中文虚构对话失败图谱

一套面向中文虚构与角色扮演对话的机器可读诊断本体，以及一个不依赖人工标注的自我纠错与规则晋升协议。

> v2 当前为 `experimental`：分类法可以用于诊断，机器演化协议与晋升门用于可审计实验，不代表模型正在在线修改自身权重。

[机器演化协议](docs/machine-evolution-protocol.md) · [结构化本体](taxonomy.json) · [v2 迁移](docs/migration-v2.md) · [五层词条](#五层诊断地图) · [可选人工指南](docs/annotation-guide.md) · [项目缘起](docs/project-background.md)

## 它现在是什么

旧版主要是一份“哪里坏了”的共享词汇表。v2 把它拆成可由机器执行、质疑和回归的四类对象：

| 类型 | 数量 | 机器应如何使用 |
|---|---:|---|
| 可观察症状 `symptoms` | 70 | 指向输出中的具体证据；可以直接诊断 |
| 因果假设 `causal_hypotheses` | 6 | 解释失败为何共现；必须允许反事实推翻 |
| 复合现象 `composite_tags` | 1 | 汇总多个症状形成的整体形态；不能替代具体症状 |
| 不确定性标记 `uncertainty_markers` | 1 | 保存尚不能区分的归因分支；不能伪装成结论 |

因此，“78”是 **78 个本体条目**，不是 78 个认识论地位相同的标签。`observability` 只表示定义中的证据通常有多容易被直接观察，也不是某一次诊断的实测置信度。

## 纯机器演化闭环

```text
生成
  ↓
证据诊断：标签 + 原文范围 + 反证 + 相邻标签排除
  ↓
对抗复核：主动尝试推翻诊断
  ↓
最小修订：只改变目标机制，声明保留约束
  ↓
匿名 A/B 与 B/A 盲测
  ↓
反事实 + 不变量 + 冻结回归
  ↓
确定性晋升门：adopted / candidate / rejected / inconclusive
```

这个链路不要求人类提交“正确标签”。人类可以抽查、否决或添加新场景，但每次运行成立所需的证据，都可以由彼此隔离的机器角色产生并交叉验证。

为了避免“模型给自己写表扬信”，晋升门默认检查：

- 生成器与 judge 的来源隔离，以及 judge 之间的来源独立；
- 原版/修订版交换位置后的结论一致性；
- 盲选 `raw_choice` 与匿名映射导出的真实 winner 是否一致；
- 诊断证据覆盖率和目标反事实通过率；
- 目标失败是否在原版成立、并在修订版真实减少；
- 带版本、摘要和污染状态的冻结回归集失败率及硬性否决；
- 未解决的高严重度反驳；
- 带独立 seed 与运行摘要的 repeat manifest。

记录结构分别定义在 [`diagnostic-trace`](schemas/diagnostic-trace.schema.json)、[`repair-attempt`](schemas/repair-attempt.schema.json)、[`verification-run`](schemas/verification-run.schema.json) 和 [`evolution-policy`](schemas/evolution-policy.schema.json) 四个 Schema 中。完整边界、状态机、Goodhart 防护和分类法自修改规则见[机器演化协议](docs/machine-evolution-protocol.md)。

## 快速验证

需要 Node.js 20 或更新版本：

```bash
npm install
npm run check
```

`npm run check` 会同时执行：

- Draft 2020-12 JSON Schema 全量校验；
- 条目计数、跨类型 ID 唯一性、`derived_from` 引用与环检测；
- 层级顺序、子类归属、Markdown 与 JSON 同步检查；
- 晋升门和故意破坏数据的负例测试。

对一份验证记录执行确定性晋升判断：

```bash
node scripts/evaluate-promotion.js --policy path/to/policy.json --run path/to/verification-run.json --pretty
```

仓库中的可运行示例：

```bash
node scripts/evaluate-promotion.js --policy examples/machine-only/evolution-policy.example.json --run examples/machine-only/verification-run.example.json --pretty
```

这些 JSON 是说明性 fixture，摘要明确标成 `example_placeholder`，所以正式门会返回 `inconclusive`，用来证明未验证 provenance 不能晋升。只有把运行中实际计算的 taxonomy、Schema、提示与制品摘要写入记录，并标记为 `verified`，才可能返回 `adopted`。

CLI 不调用模型，也不会补猜缺失证据。退出码分别为：`0 adopted`、`2 candidate`、`3 rejected`、`4 inconclusive`、`64 输入错误`。

## 五层诊断地图

I → V 是推荐检查顺序，不是严重度或单一因果层级。多个层的症状可以同时成立。

| 层 | 分析维度 | 核心问题 | 症状数 | 完整词条 |
|---|---|---|---:|---|
| I | 结构性前提 | 场景是否成立，角色、信息和世界规则边界是否完好？ | 9 | [前置条件](layers/layer-1-preconditions.md) |
| II | 认知归因 | 潜台词、情绪、动机和关系逻辑是否被正确读取？ | 8 | [意义读取](layers/layer-2-semantic-reading.md) |
| III | 生成保真 | 即使读对了，输出是否守住场景的张力与重量？ | 25 | [场景保留](layers/layer-3-scene-preservation.md) |
| IV | 写作习惯 | 模型的模板、质感或默认声音是否覆盖场景需求？ | 17 | [写作侵入](layers/layer-4-writing-intrusion.md) |
| V | 时序一致性 | 多轮中是否发生漂移、重置、断层或错误累积？ | 11 | [多轮失败](layers/layer-5-multi-turn.md) |
| — | 解释与辅助 | 哪些是可证伪假设、复合现象或尚未解决的不确定性？ | 6 + 1 + 1 | [跨层条目](layers/cross-layer.md) |

诊断时先写证据，再写标签；先记录可观察症状，再提出因果假设。遇到 Layer II“没读出”和 Layer III“没守住”无法区分时，使用 `reading_preservation_hybrid` 保存不确定性，不靠多贴标签掩盖它。

## 仓库结构

```text
taxonomy.json                  版本化本体数据
taxonomy.schema.json           本体 Schema
layers/                        70 个症状与 8 个辅助条目的完整说明
schemas/                       机器演化记录 Schema
examples/machine-only/         纯机器记录样例
lib/evolution-gate.js          无模型依赖的确定性晋升门
scripts/evaluate-promotion.js  晋升门 CLI
test/                          正例、负例与抗偏差测试
docs/                          协议、可选人工指南与项目背景
```

## 设计边界

- 本项目是诊断本体与验证协议，不是已经完成标注的 benchmark 数据集。
- 当前代码实现记录契约、严格校验和确定性晋升门，尚未绑定任何模型提供方，也不会自己发起生成/诊断 API 调用；提供方适配器与全链编排器属于下一阶段。
- `digest_status: verified` 是编排器签署的 provenance 断言；当前 CLI 会拒绝 placeholder，但不会自行下载并重算所有外部模型、提示或远程工件。生产编排器仍必须负责计算摘要并保护记录存储。
- “理解后没守住”是有用的外部归因，不宣称对应模型内部真实的两阶段心智过程。
- 同一基础权重可以承担不同机器角色，但完整来源相同、上下文串联或可互相泄露答案时，不算独立证据。
- 当前 policy 为机器分类法提案预留了目标类型，但专用 proposal payload、迁移表和自动应用器尚未实现；现阶段机器不能用这四类记录直接改写分类法。未来启用时，核心锚点、当前版本和影子回归集必须分层冻结，不能在一次运行中一边改尺子一边宣布自己进步。
- `adopted` 表示记录通过当前策略阈值，不等于跨模型、跨任务或永久成立。

## 人工入口

[人工标注指南](docs/annotation-guide.md)仍然保留，用于兼容旧流程、抽查机器记录和审阅争议案例。它不是纯机器模式的依赖，也不是唯一真值来源。

## English brief

CN Failure Atlas v2 is a machine-readable ontology for structural failures in Chinese fictional and roleplay dialogue. It separates 70 observable symptoms from 6 causal hypotheses, 1 composite, and 1 uncertainty marker, then defines a provider-neutral machine-only loop for diagnosis, adversarial review, minimal repair, blinded verification, counterfactual testing, regression, and deterministic promotion.

## License

本项目沿用 [CC BY 4.0](LICENSE)。引用或改编时请署名原作者 Yuqing Cai，并指向本仓库。
