# Design: Schema Validation Pipeline

> 历史说明：本文保留 v1 的实现设计。v2 不再使用手写的局部 Schema 检查，当前结构请见根目录 `validate.js`、`schemas/` 与 `test/`。

## 文件结构

```
cn-failure-atlas/
├── validate.js          ← 新增：验证脚本入口
├── package.json         ← 新增：定义 npm run validate
├── taxonomy.json        ← 已有
├── taxonomy.schema.json ← 已有
└── layers/*.md          ← 已有
```

## validate.js 架构

```
main()
├── loadData()                    // 读 taxonomy.json + schema + layers/*.md
├── checkRequiredFields()         // R1: 手写 schema 字段检查
├── checkTotalLabels()            // R2: 计数一致性
├── checkIdUniqueness()           // R3: 全局唯一 ID
├── checkDerivedFromIntegrity()   // R4: 引用完整性
├── checkSubcategoryPrefix()      // R5: 子类前缀
├── checkMarkdownSync()           // R6: MD ↔ JSON 同步
├── checkTendencyLayers()         // R7: tendency 层引用
└── report()                      // 汇总输出，分 error/warning
```

## 输出格式

```
✓ R1 JSON Schema 合规
✓ R2 total_labels 计数一致 (78)
✗ R3 标签 ID 全局唯一
    重复: emotion_misread (Layer II / Layer III)
✓ R4 derived_from 引用完整
⚠ R6 Markdown ↔ JSON 同步
    warning: JSON 有但 MD 未提及: [new_tag_xyz] (layer-3)
    error: MD 引用但 JSON 无: [typo_tag] (layer-2)

结果: 1 error, 1 warning — 验证失败
```

## 退出码

- 0: 全部通过（warning 不影响）
- 1: 存在 error
