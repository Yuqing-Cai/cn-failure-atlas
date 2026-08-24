# 中文虚构对话失败图谱

把中文虚构与角色扮演对话中那些“读着顺，却把场景写坏了”的问题，整理成可举证、可重放、可检验的机器分类法。

Atlas v2 还提供一条纯机器修复链：冻结场景，定位原文证据，提出最小修订，再用隔离评审和回归测试决定是否保留这次修复。人工审阅保留为随时可插入的检查通道。

```text
冻结场景 → 生成 → 诊断 → 对抗复核 → 最小修订
                            ↓
           匿名偏好 + 目标审计 + 回归 → 候选 / 晋升 / 拒绝 / 隔离
```

当前版本为 `experimental`。

[浏览分类法](taxonomy.json) · [阅读机器演化协议](docs/machine-evolution-protocol.md) · [查看 v2 迁移](docs/migration-v2.md) · [人工审阅指南](docs/annotation-guide.md) · [项目缘起](docs/project-background.md)

## 诊断地图

分类法包含 70 个可观察症状、6 个可证伪的因果假设、1 个复合现象和 1 个不确定性标记。I → V 是推荐检查顺序，不代表严重度，也不对应模型内部阶段。

| 层 | 维度 | 症状数 | 词条 |
|---|---|---:|---|
| I | 结构性前提 | 9 | [前置条件](layers/layer-1-preconditions.md) |
| II | 认知归因 | 8 | [意义读取](layers/layer-2-semantic-reading.md) |
| III | 生成保真 | 25 | [场景保留](layers/layer-3-scene-preservation.md) |
| IV | 写作习惯 | 17 | [写作侵入](layers/layer-4-writing-intrusion.md) |
| V | 时序一致性 | 11 | [多轮失败](layers/layer-5-multi-turn.md) |

因果假设、复合现象和不确定性标记见[跨层条目](layers/cross-layer.md)。

## 跑起来

需要 Node.js 20 或更新版本：

```bash
npm ci
npm run check
```

样例包含一套完整的晋升门输入。先把演示信任根的 RFC 8785 规范 JSON 摘要写入部署环境：

```bash
export CN_FAILURE_ATLAS_TRUST_ROOT_SHA256=331081e1223066708d8ca15750a72b8e13713a866554bb1d1b59897dd71ab703

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
$env:CN_FAILURE_ATLAS_TRUST_ROOT_SHA256 = "331081e1223066708d8ca15750a72b8e13713a866554bb1d1b59897dd71ab703"
```

> **样例密钥不能用于生产。** 生产部署需从独立配置或密钥系统预先固定信任根摘要，并由外部签发器防止 `single_use_nonce` 复用。完整威胁模型见[协议的信任边界](docs/machine-evolution-protocol.md#信任边界)。

样例会返回 `inconclusive`：本地摘要与签名能够验证，远程模型、提示和运行来源仍是占位值。`scripts/print-trust-root-digest.js` 可在部署前离线核对或生成预配值；运行时不能从本次提交的信任根临时推导该值。

维护样例时，先运行 `npm run reseal:examples` 重算内容摘要，再运行 `npm run issue:example-receipt` 签发新的演示密钥与五阶段收据。

## 目前能走多远

确定性 Gate 会重算并核对整份证据包。即使全部通过，它也只把当前案例的 `repair_case` 返回为 `adopted`。

当前唯一可执行的 recipe 对应 `premature_affective_closure`。70 个症状中，23 个已有 `specified` 自然语言区分测试；另 47 个明确记为 `underspecified`，等有逐项边界证据后再补。

因此，六个因果假设目前都达不到“两组可执行症状”的机器门槛。`repair_strategy` 也要等跨独立留出案例的适用性证据进入协议后才会开放。

仓库只负责判定；模型运行和状态落地仍由外部编排器完成。模型接入、权重更新与真实语料校准尚未实现。此处的 `adopted` 只表示这件案例级修复工件通过了当前冻结的 policy。

English: CN Failure Atlas is an experimental machine-readable taxonomy and machine-only self-correction protocol for structural failures in Chinese fictional and roleplay dialogue.

## License

[CC BY 4.0](LICENSE) · Yuqing Cai
