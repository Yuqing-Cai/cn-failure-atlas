# 中文虚构对话失败图谱

面向中文虚构与角色扮演对话的机器可读失败本体，以及一套无需人工标注的自我纠错与规则晋升协议。

> v2 处于 `experimental` 阶段：已实现分类法、记录 Schema、语义校验器与确定性晋升门；尚未接入模型提供方、自动编排或权重更新。

[浏览本体](taxonomy.json) · [机器演化协议](docs/machine-evolution-protocol.md) · [v2 迁移](docs/migration-v2.md) · [可选人工指南](docs/annotation-guide.md) · [项目缘起](docs/project-background.md)

## 核心设计

图谱包含：

- 70 个可由输出证据支持的症状
- 6 个必须允许反事实推翻的因果假设
- 1 个复合现象
- 1 个不确定性标记

它们不是认识论地位相同的“78 个标签”。机器应先引用证据、记录症状，再提出因果解释。

```text
生成 → 证据诊断 → 对抗质疑 → 最小修订
     → A/B 与 B/A 盲测 → 冻结回归 → 晋升、观察、拒绝或隔离
```

协议要求由彼此隔离的机器角色承担诊断、质疑、修订和评审，不要求人类提供正确标签。人工审阅只是一种可选审计手段。

## 五层诊断地图

I → V 是推荐检查顺序，不代表严重度。

| 层 | 维度 | 症状数 | 完整词条 |
|---|---|---:|---|
| I | 结构性前提 | 9 | [前置条件](layers/layer-1-preconditions.md) |
| II | 认知归因 | 8 | [意义读取](layers/layer-2-semantic-reading.md) |
| III | 生成保真 | 25 | [场景保留](layers/layer-3-scene-preservation.md) |
| IV | 写作习惯 | 17 | [写作侵入](layers/layer-4-writing-intrusion.md) |
| V | 时序一致性 | 11 | [多轮失败](layers/layer-5-multi-turn.md) |

因果假设、复合现象和不确定性标记见[跨层条目](layers/cross-layer.md)。

## 快速开始

需要 Node.js 20 或更新版本：

```bash
npm ci
npm run check
```

运行确定性晋升门：

```bash
node scripts/evaluate-promotion.js \
  --policy examples/machine-only/evolution-policy.example.json \
  --run examples/machine-only/verification-run.example.json \
  --pretty
```

示例使用占位摘要，因此会如预期返回 `inconclusive`。生产编排器负责签发 `verified` 来源声明；CLI 校验记录，但不重算外部制品摘要。

## 当前边界

本仓库已经实现记录契约、严格校验、对盲测记录的防偏差检查和确定性晋升门，但不会自行调用模型或修改权重。提供方适配器、自动编排与分类法自动迁移属于下一阶段。

`adopted` 只表示候选通过当前策略阈值，不代表跨模型、跨任务或永久有效。

English: CN Failure Atlas is a machine-readable ontology and machine-only self-correction protocol for structural failures in Chinese fictional and roleplay dialogue.

## License

[CC BY 4.0](LICENSE) · Yuqing Cai
