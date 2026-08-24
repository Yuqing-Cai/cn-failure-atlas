# 中文虚构对话失败图谱

面向中文虚构与角色扮演对话的机器可读失败分类法，以及一套不依赖人工标注的自我纠错协议。

> v2 仍处于 `experimental`：仓库已实现分类法、记录 Schema、证据链校验和确定性晋升门；尚未接入模型服务、全链编排或权重更新。

[分类法](taxonomy.json) · [机器演化协议](docs/machine-evolution-protocol.md) · [v2 迁移](docs/migration-v2.md) · [可选人工指南](docs/annotation-guide.md) · [项目缘起](docs/project-background.md)

## 它解决什么

Atlas 把诊断对象分成四种认识论类型：

- 70 个可从输出中举证的症状；
- 6 个可被反事实推翻的因果假设；
- 1 个复合现象；
- 1 个不确定性标记。

机器必须先引用原文；只有存在结构化 recipe 的症状才能重放冻结测试并进入修复。诊断、质疑、修订和评审由隔离角色承担；人工审阅只是可选审计。

```text
冻结契约 → 生成 → 结构化诊断 → 可重放修订
        → 隔离的匿名偏好 + 目标审计 → 晋升或隔离
```

## 五层诊断地图

I → V 是推荐检查顺序，不代表严重度或模型内部处理阶段。

| 层 | 维度 | 症状数 | 词条 |
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

完整晋升门还要求候选不可写的信任根和五阶段签名链：生成前承诺、输出后的诊断承诺、修复前承诺、试验前承诺、完成证明。部署环境必须**预先配置**信任根的 RFC 8785 规范 JSON 摘要；它不是原始文件字节的哈希，也不能在评估时从同一份信任根临时推导：

```bash
export CN_FAILURE_ATLAS_TRUST_ROOT_SHA256=fb61ad100edea08d6560e47d2359457c2bd333e128af200fdd81868b18c52dcb

node scripts/evaluate-promotion.js \
  --policy examples/machine-only/evolution-policy.example.json \
  --trace examples/machine-only/diagnostic-trace.example.json \
  --repair examples/machine-only/repair-attempt.example.json \
  --run examples/machine-only/verification-run.example.json \
  --taxonomy taxonomy.json \
  --trust-root config/promotion-trust-root.example.json \
  --run-receipt config/promotion-run-receipt.example.json \
  --pretty
```

PowerShell 对应写法：

```powershell
$env:CN_FAILURE_ATLAS_TRUST_ROOT_SHA256 = "fb61ad100edea08d6560e47d2359457c2bd333e128af200fdd81868b18c52dcb"
```

上面的固定值只对应仓库样例。`scripts/print-trust-root-digest.js` 仅供部署前离线核对或生成新的预配值，不能充当运行时信任来源；生产摘要应由独立部署配置或密钥系统提供。仓库中的信任根、公钥与签名也只用于演示格式，不能复制到生产环境。示例会返回 `inconclusive`：本地摘要与签名可验证，但远程模型、提示和运行来源仍标为占位。只有完整、受信且可重放的证据包才可能得到 `adopted`；生产签发器还必须在外部持久化并拒绝重复的 `single_use_nonce`。

维护样例时，先运行 `npm run reseal:examples` 重算内容摘要，再运行 `npm run issue:example-receipt` 签发新的演示密钥与五阶段收据。

## 当前边界

- 晋升门目前只执行案例级 `repair_case`；编辑必须可重放且逐字生成候选。`repair_strategy` 在具备跨独立留出案例证据前明确不可晋升。
- 70 个症状中目前只有 `premature_affective_closure` 有结构化机器 recipe；其余 69 项的自然语言测试只作设计提示，不能晋升。因此 6 个因果假设目前也无法满足“两组可执行症状”门槛。
- 本仓库不调用模型、不自动应用策略，也不直接更新权重。
- nonce 消费、实验族注册、模型调用、回归集取回/执行和状态迁移仍由外部编排器负责；仓库内签名不能单独证明“每个请求只调用模型一次”。
- `adopted` 只表示这一案例的修复工件通过当前冻结 policy，不代表策略已泛化，更不代表跨模型、跨任务或永久有效。
- 分类法和 judge 尚缺真实语料上的经验校准；机器闭环不能替代外部效度证明。

English: CN Failure Atlas is an experimental machine-readable taxonomy and machine-only self-correction protocol for structural failures in Chinese fictional and roleplay dialogue.

## License

[CC BY 4.0](LICENSE) · Yuqing Cai
