# 纯机器演化协议

本协议定义 CN Failure Atlas 如何在**不把人类放进必经链路**的前提下，让机器发现失败、提出修复、验证修复，并逐步积累可供后续演化的证据。

纯机器模式是第一等公民，不是“缺少人工时的降级模式”。人类可以旁观、抽查、否决或提供新的场景，但这些动作都不是一次演化运行成立的必要条件。

这里的“演化”指以下可审计对象的版本变化：

- 单次输出的修复方案与对照案例；
- 生成、诊断、验证所使用的提示与策略；
- 可检索的经验规则和回归测试；
- Atlas 分类法的边界、关系与版本。

它**不等于模型权重在线自动更新**。如果未来用晋升记录训练或微调模型，那是独立的训练流水线；本协议只负责生成可信的训练候选、策略版本和验证证据。

当前仓库已经实现四类运行记录、内容寻址证据包、冻结测试承诺、跨记录校验和确定性晋升门；当前门只会晋升**这一案例的修复工件**，不会从单例推出通用策略。通用策略必须先增加未参与修复的独立案例清单及逐案例应用证据，当前明确返回未实现。仓库也尚未实现绑定具体模型服务的全链编排器。正式 `adopted` 必须同时提供 policy、taxonomy、diagnostic、repair、verification、候选不可写的 trust root，以及受信编排器签发的**五阶段证明链**：生成前、诊断前、修复前、验证试验前、运行完成后各有明确承诺。只有 policy/run 的两文件模式仅供诊断。下文步骤是编排器必须执行的协议，不表示仓库会自行调用模型。policy 的 lifecycle 图由 Schema 精确冻结，Gate 校验当前结果与 `lifecycle_state` 的映射；真正迁移状态或执行 rollback 仍由外部编排器负责。

---

## 一、基本原则

1. **修复必须赢过原版，而不只是看起来更会解释。** 诊断理由不能充当修复有效的证明。
2. **生成、诊断、反驳和裁决相互隔离。** 偏好通道只见匿名候选；目标/证据审计由另一组 actor 在新上下文中执行。上游诊断或修复 actor 不得换名复用为偏好 judge。
3. **所有结论都落到可观察证据。** 标签必须指向原文、轮次、场景契约或对照样本；“更自然”“更高级”不能单独构成证据。
4. **一次只改最少的东西。** 修复需要明确目标标签、允许变化和必须保持不变的内容，避免用整段重写掩盖真正原因。
5. **晋升依赖反事实和回归，不依赖自我认同。** 一条规则既要修复目标案例，也要在相邻案例上知道何时不该触发。
6. **允许弃权、隔离和失败。** 系统不得通过不断重采样，直到抽到支持自己的裁决。
7. **协议和阈值先于结果确定。** 一次运行开始后，不得为了让候选通过而修改评分维度、容差或停止条件。

---

## 二、标准演化链

```text
生成 → 证据诊断 → 对抗复核 → 最小修订 → 盲化验证 → 反事实 / 回归 → 晋升或拒绝
```

### 1. 生成

生成器只接收场景契约、历史上下文和当前输入，产出原始回答。场景契约至少包括：

- 用户角色与模型角色的控制边界；
- 角色已知信息、世界规则和版本；
- 当前关系、情绪、空间位置与未解决事项；
- 本轮意图，以及明确不可被提前解决的内容。

原始回答写入不可变记录。`subject.generator_output_turn_ids` 明确列出哪些 assistant turns 可以支撑症状；每个 turn 归属一个 scene，每个 scene 同时携带完整契约和可重算摘要。主输出所属 scene 的内嵌契约必须与顶层 `scene_contract` 完全一致。后续任何修订都产生新版本，不覆盖原文。

### 2. 证据诊断

诊断器按 Atlas 的检查顺序提出候选失败，但必须同时提交：

- 具体标签、作用范围和证据片段；
   - 只有 taxonomy 中带结构化 `test_recipes` 且列入 `machine_execution_policy.executable_symptom_ids` 的症状，才可执行并写入 `taxonomy_test_results`；自然语言 `discriminating_tests` 只是设计提示；
- 对 `confusable_with` 已声明的近邻逐一提交“为什么不是它”的 `neighboring_label_rebuttals`；未冻结近邻时不得为了承载测试而编造一个邻居；
- 支持“不构成失败”的反证；
- `present`、`absent`、`uncertain` 或 `not_applicable`；
- 如果标签成立，修复应改变什么、必须保留什么。

开放式扫描得到的是候选，不是结论。无法在相邻标签之间稳定区分时，应保留不确定性，不用多贴标签代替判断。

### 3. 对抗复核

复核器看得到场景和诊断结论，但看不到诊断器的隐藏推理。它的任务不是补充更多标签，而是尝试推翻当前诊断：

- 证据能否由正常角色发展、类型惯例或上下文解释；
- 诊断是否把个人审美误写成结构性失败；
- 标签是否越过了自身适用范围；
- 是否存在更小、更具体的相邻标签；
- 预期修复是否可能伤害角色声音、张力或用户意图。

诊断只有在回应这些反例后，才能进入修订。若核心证据仍然冲突，状态转为 `quarantined`，而不是强行取多数票。

### 4. 最小修订

修订器接收原文、已确认的目标问题和保留约束，不接收裁决偏好或通过阈值。当前 alpha 只支持单一 primary output turn；它必须提交 Unicode code-point 片段替换，Gate 重放全部 edit，并要求结果逐字等于候选：

- 修改了哪些片段；
- 每处修改对应哪个失败机制；
- 哪些信息、动作、关系不对称和语言特征被刻意保留；
- 可能引入的次生风险。

如果必须同时改变情节方向、角色动机和文体，说明诊断粒度可能过粗，应返回诊断阶段，而不是把大改写记为单一标签的成功修复。

### 5. 盲化验证

验证分成两个不共享上下文的通道。**偏好 judge** 只看到场景契约与两个匿名候选，不知道：

- 哪个是原版、哪个是修订版；
- 目标标签是什么；
- 生成器或修订器的身份；
- 其他验证器的选择。

每一对至少执行 A/B 与 B/A 两种顺序；每个 judge × repeat × order 都有独立 invocation、context partition 和由 repeat seed 确定导出的 trial seed。实际 A/B 映射使用高熵 nonce 加盐承诺，并在候选产生后、第一次试验前签名冻结。

**审计 judge** 可以看到 baseline/candidate 的角色标记、finding、证据与保留约束，用于 `evidence_checks`、`target_failure_checks`、反事实和回归；它看不到候选的 producer/model/provider 身份，因此是目标感知审计，而不是 label-blind 盲评。每项审计都以请求摘要绑定具体候选内容、场景契约、finding/证据或回归锚点、judge、独立 invocation/context/seed，并与偏好通道及上游角色全局隔离。

阻断性挑战也不是一段可事后解释的自由文本。repair critic 必须先声明 `challenge_kind`、目标 findings，以及**确切**的 `required_resolution_check_ids`；verification-stage raiser 在新上下文中接收并逐字交接这份既有挑战，不能静默替换。verification 只能用同一组 ID 解挑战，不得看过结果后换成或追加另一项通过的检查。`target_failure_persists` 只能由确认 baseline 有而 candidate 无的 target-failure check 解决，`evidence_not_reduced` 只能由确认 `evidence_reduced` 的 target-failure check 解决，`diagnostic_counterfactual_invalid` 只能由通过的 counterfactual check 解决。raiser 请求摘要绑定既有挑战和其他输入；resolver 请求摘要绑定挑战及预承诺检查，但不包含 resolver 尚未产出的 `response`。时间线强制满足“交接挑战 < 执行检查 ≤ resolver 完成”。

如果同一判断在换序后反转，记为评价器顺序敏感并返回 `inconclusive`，不得把它误记成候选失败，也不得当作一胜一负后简单相抵。当前 policy 的顺序容差为零：任一 judge/repeat 对换序不一致，整批验证即无效。

### 6. 反事实与回归

候选修复要通过三类证据门：

- **目标减少：** `target_failure_checks` 必须先确认原版存在目标失败，再确认候选中的同一机制减少或消失；
- **诊断来源反事实：** `counterfactual_checks` 只能引用已通过的结构化 taxonomy test execution，精确绑定 recipe、source execution、确定性干预及 scene-contract 不变量路径。它证明诊断来源可重放，并记录独立 audit 判断；当前实现不声称已把任意新变换直接执行在候选上；
- **回归测试：** 在受信 registry 固定的旧案例上检查保留约束；每个已执行的注册案例都沿用 registry 的 `hard_veto` 失败语义。

修复器不得看到影子测试的具体内容。验证完成后，影子样本若已泄露给修复器，就标记为已污染，并在下一轮替换。

### 7. 晋升

晋升不是“多数 judge 喜欢修订版”，而是所有预先声明的门槛同时成立：

- 修订版必须在每个已声明 judge × repeat 的两个位置顺序中都胜过原版；当前门不使用可相互抵消的总分优势；
- 目标标签的证据减少，且不是靠删除场景难度实现；
- 没有任何硬性回归维度触发否决；
- 诊断来源的结构化反事实重放及其 scene-contract invariants 通过；
- 案例级修复必须在预承诺的新随机种子上重复；若要晋升通用策略，还必须在未参与修复的新案例上复现；
- 运行记录、模型版本、提示版本和测试集摘要完整。

当前契约把重复执行收在同一份 `verification_run` 的 repeat manifest 中，并强制每次偏好 invocation 使用不同 context 与确定性派生 seed。它降低上下文串扰，但仍不等同于统计学上的独立样本。repeat 数不足时返回 `candidate`；达到下限且全部门通过时，只能把当前 `repair_case` 返回为 `adopted`。`repair_strategy` 尚未实现，不能用同一候选的重复试验代替跨案例泛化证据。这些只是供外部编排器执行的判定。

Gate 会从 policy、taxonomy、diagnostic、repair、冻结清单、候选内容、盲化映射，以及逐 trial/check 的偏好与审计请求摘要重算所有 repeat 共享的 `input_digest`。每个 repeat 的 `run_digest` 则只绑定该 repeat 的 `repeat_id`、seed、`input_digest`、执行时间，以及属于该 repeat 的 AB/BA `order_trials`；它**不**单独覆盖全局的 evidence、target-failure、counterfactual、regression 或 challenge 集合。这些集合在 verification record、冻结 `evaluation_manifest` 与整体运行凭据层接受另外的完整性检查。因此 `run_digest` 证明的是该 repeat 的配对试验记录没有被静默替换，不应被描述成“每个 repeat 都独立封存了整套验证”。

policy 可以声明稳定退化后的 rollback 条件和目标，Gate 也会检查这些声明是否与冻结 policy 一致；真正恢复上一条策略仍需要仓库之外的策略存储与执行器。

这里的“全部成对判断都胜出”是保守的工程门，不是统计显著性证明。正式实验仍应报告案例级效果量、不确定区间、judge 相关性和适用总体；不得把八次相关判断描述成八份独立证据。

仓库中的确定性晋升门使用更适合单次执行的四个返回值，并校验记录中的生命周期映射：`candidate` 表示当前证据通过但独立重复数不足，记录应声明 `probation`；`adopted` 表示当前案例级工件通过全部阈值，记录可声明 `promoted`；`rejected` 表示已有充分失败证据；`inconclusive` 表示独立性、换序覆盖或测试证据不足，记录应声明 `quarantined` 而不是被学习成失败。返回值由记录事实确定，不由 judge 直接投票指定；是否把声明写入真实状态存储，由外部编排器负责。

---

## 三、四类记录

记录均为追加式：更正通过新记录的可选 `supersedes_ref` 引用旧记录完成，不原地改写历史。外部编排器若把候选登记为 `probation`，后续用新验证记录补足 repeat 时，也应使用该字段连接前一份验证。

`taxonomy.json`、`taxonomy.schema.json`、下面四份运行记录 Schema，以及 trust-root / run-receipt Schema 共同构成可执行契约；协议只解释其含义，不另维护一套近似字段名。

| 记录 | 主键 | 作用 | Schema / 样例 |
|---|---|---|---|
| `diagnostic_trace` | `trace_id` | 保存逐 scene 的完整契约及摘要、明确的生成输出轮次、机器角色隔离、证据/反证、finding 级边界测试、近邻标签排除和诊断处置 | [Schema](../schemas/diagnostic-trace.schema.json) / [样例](../examples/machine-only/diagnostic-trace.example.json) |
| `repair_attempt` | `repair_id` | 引用诊断轨迹，保存原版与候选、最小编辑计划、保留约束、批评器检查和盲测交接摘要 | [Schema](../schemas/repair-attempt.schema.json) / [样例](../examples/machine-only/repair-attempt.example.json) |
| `verification_run` | `verification_id` | 保存匿名候选、AB/BA 试验、证据/反事实/回归检查、挑战轮、重复运行和确定性门输出 | [Schema](../schemas/verification-run.schema.json) / [样例](../examples/machine-only/verification-run.example.json) |
| `evolution_policy` | `policy.id` + `policy.version` | 冻结角色隔离、五项阈值、必需验证套件、生命周期、停止和回滚条件 | [Schema](../schemas/evolution-policy.schema.json) / [样例](../examples/machine-only/evolution-policy.example.json) |

外部信任边界另见 [trust-root Schema](../schemas/promotion-trust-root.schema.json)、[run-receipt Schema](../schemas/promotion-run-receipt.schema.json) 及其 [样例配置](../config/promotion-trust-root.example.json)。五阶段链依次绑定：场景与生成 actor；输出与诊断/test actor；修复输入与候选无关的验证计划；候选、加盐匿名映射及逐 trial/check 请求；最终诊断、修复、验证证据与候选摘要。完成摘要刻意排除可确定性重算的 `promotion_gate` 派生视图，Gate 会另行核对它。`single_use_nonce` 的消费状态必须由外部签发器持久化，离线 Gate 无法独自证明它从未被重复使用。

这五个签名证明“受信 issuer 对所选请求、时间顺序和结果作了何种承诺”，不证明模型提供方实际上只响应过一次，也不能排除未登记的隐藏重采样。生产环境若要提出后一种强保证，必须增加 provider-signed invocation receipt 或候选不可写的调用账本，并把 request/response digest、时间与 nonce 一同登记。Gate 计算记录中可见模型调用的确定性下界，并强制 `diagnostic ≤ repair ≤ verification` 的累计增量，防止调用数归零、倒退或用分阶段数字掩盖预算超支；本地确定性聚合不计作生成式模型调用。

四类记录都要求 `mode` 与版本 provenance。policy 以 `policy_digest` 固定可执行规则；诊断、修复和验证共享 `experiment_ledger`，记录实验族、尝试序号、预算与结构化停止规则；verification 还必须提交类型化 `promotion_artifact` 与冻结的 `evaluation_manifest`。清单不仅冻结 case ID，还冻结执行前字段的规范摘要。跨记录引用、候选内容、Schema、分类法和测试输入均以可重算 digest 绑定。`human_review` 是可选扩展字段，不是任何 Schema 的必填条件。

`digest_status: example_placeholder` 只允许说明性 fixture 通过结构校验，正式晋升门必须将它隔离为 `inconclusive`；只有 `verified` provenance 才能参与晋升。

`verified` 不是单独生效的自报值。Gate 还会重算本地 Schema 摘要，把 runner 与 prompt bundle 对照外部 trust root，验证前置签名是否在候选生成前固定了 policy、taxonomy、账本和 evaluation manifest，并验证完成签名是否绑定最终四类工件。CLI 另外要求部署环境用 `CN_FAILURE_ATLAS_TRUST_ROOT_SHA256` 固定 trust root 的 RFC 8785 规范 JSON 摘要；本次运行不能自行选择另一份根来放宽规则。仅把字符串改成 `verified` 不构成来源证明。

匿名映射只对聚合器可见，偏好 judge 只提交 `raw_choice`；`winner` 由加盐映射承诺重算。修复前只冻结候选无关的盲化协议，真实映射在候选产生后才承诺，避免让 repairer 枚举 A/B，也避免看到结果后换 alias。

验证记录还必须保存 `repeat_manifest`（独立 seed、可重算的共同输入摘要，以及只覆盖各 repeat AB/BA 配对试验的运行摘要）、`target_failure_checks`（原版存在、候选减少或消失）以及带 suite/case 版本、digest、污染状态和 `hard_veto` 的回归项。`evaluation_manifest` 必须同时与实际 case ID 全集和执行前字段摘要精确匹配：少报、多报、换壳或重复灌水都会隔离。全局 evidence、target-failure、counterfactual、regression 和 challenge 项不属于单个 repeat 的 `run_digest` 投影，不能把后者误当成整套验证结果的逐 repeat 封印。所有验证 invocation 还必须在 verification precommit 之后、completion 之前留下 `executed_at`。这样“重复过”“目标问题变少了”“跑过冻结回归”都必须分别回到相应记录与完整性检查，而不是一枚无来源的布尔值。

trust root 的 regression registry 只让 Gate 验证 suite/case 的权威 ID、版本与内容摘要，并强制必跑覆盖和 `hard_veto` 语义；Gate 不会自行取回 URI、验证远端字节可用性或执行测试。生产 resolver/runner 必须按 registry URI 取回规范 JSON、核对 digest 并签发执行回执；仓库样例中的重复数字摘要只是格式 fixture，不是可复用的生产锚点。

---

## 四、状态机

下图是 policy 要求外部编排器遵循的**规范状态机**。当前 Gate 会验证确定性返回值与记录所声明的 `lifecycle_state` 是否匹配，但不会创建、迁移或持久化这些状态，也不会执行图中的 rollback 箭头。

```text
generated      → diagnosed | quarantined
diagnosed      → challenged | quarantined
challenged     → repair_proposed | quarantined
repair_proposed→ verifying | rejected
verifying      → promoted | probation | rejected | quarantined
probation      → promoted | rejected | quarantined
promoted       → deprecated | rolled_back
```

状态转换规则：

| 当前状态 | 进入下一状态的必要条件 | 可能去向 |
|---|---|---|
| `generated` | 原始输出与运行配置已封存；封存或来源失败则隔离 | `diagnosed`、`quarantined` |
| `diagnosed` | 每个候选均有证据、反证和近邻边界 | `challenged`、`quarantined` |
| `challenged` | 对抗复核未发现未解决的核心冲突 | `repair_proposed`、`quarantined` |
| `repair_proposed` | 差异、目标与保留约束可机器检查 | `verifying`、`rejected` |
| `verifying` | 盲化、换序、反事实和回归均完成 | `promoted`（全部门与 repeat 下限均通过）、`probation`、`rejected`、`quarantined` |
| `probation` | 新验证记录补足 repeat manifest 后重新裁决 | `promoted`、`rejected`、`quarantined` |
| `promoted` | 已成为默认可检索规则或策略 | `deprecated`、`rolled_back` |

`rejected` 表示证据足够且候选未通过；`quarantined` 表示证据条件本身不可靠。两者不能混用，否则系统会把“无法判断”学习成“修复无效”。

---

## 五、纯机器模式的主要失真与防护

### 1. 机器自证循环

最危险的闭环是：同一个模型先定义错误，再按自己的定义改写，最后因为修订更符合自己的说明而判定成功。

机器化防护：

- 原始输出、诊断、修复、测试和匿名映射分别封存；
- judge 不接收诊断 rationale，只接收场景与候选；
- 诊断证据和验证证据分开记录，不允许相互复制；
- 至少设置一个“诊断可能不成立”的对抗角色；
- 使用旧版本冻结锚点和未参与提案的新样本；
- 聚合器是确定性规则执行器，不再调用生成式模型“综合判断”。

多次采样只能证明结果可重复，不能自动证明结论真实。

### 2. 同源 judge

不同角色提示不等于独立 judge；同一基础模型的十次投票也不是十份独立证据。每次验证都应标记独立性等级：

```text
I3  不同模型家族或训练来源
I2  不同模型版本 / 提供方，已知可能同源
I1  同一模型，不同提示族、上下文隔离与随机种子
I0  同一上下文或共享推理，结果不可用于晋升
```

纯机器模式允许同一基础模型承担生成、诊断或修复等不同逻辑角色，但当前正式晋升门不会把 I1 的多个 judge 计为多个独立来源：它们可以用于开发、对抗复核和发现候选，不能单独满足 `min_independent_judges`。正式晋升至少需要 policy 指定数量的规范化不同来源；相同 provider/model/version 即使具有不同微调摘要，也仍按共享基础谱系处理，相同权重摘要则必然同源。身份来源不同仍不等于统计误差独立，生产校准还应报告 judge 间经验相关性。I1 的重复样本不得在报告中伪装成更高独立性；I0 只能用于调试。

### 3. 顺序与长度偏差

- 每个比较必须同时做 A/B 与 B/A；
- 候选代号、展示顺序和模型身份均随机化；
- 将“更长”“解释更多”“措辞更精致”设为显式混淆因素；
- 对显著长度差使用等长摘要或分维判断，但保留原文复核；
- 换序反转单独统计，不用平均分掩盖；
- 当前零容差：出现任何位置不一致即隔离整批，不挑选有利轮次。

### 4. 规则漂移

- `taxonomy`、`policy`、提示和锚点均使用独立版本号与内容哈希；
- trust root 由候选不可写的部署配置固定，不能随候选包提交或由本次调用任意替换；
- 编排器在候选生成前签署 run receipt 的请求部分，并在运行结束后签署 completion；包内自报时间戳、单阶段签名或未持久化的一次性 nonce 都不能代替外部编排；
- 每次运行固定全部版本，运行中不热更新；
- 新规则必须回放上一稳定版本的全部冻结锚点；
- 不允许在同一个提案里同时修改规则和使该规则通过的锚点；
- 边界发生破坏性变化时升主版本，旧版结果保留原义，不回填重写；
- 连续出现“修复 A → 破坏 B → 修复 B → 再破坏 A”的循环时停止并隔离候选。

### 5. Goodhart 化

当某个代理分数成为晋升目标，系统会学会提高分数，而不是修复场景。

机器化防护：

- 不把所有维度压成单一总分；使用目标改善 + 硬性否决的门控；
- 修复器看不到影子样本、聚合权重和精确通过阈值；
- 定期加入未被当前指标直接覆盖的“副作用探针”；
- 同时测量遗漏与过度触发，避免“少犯一个标签”的最简单办法变成少写、删戏或全部中性化；
- 以跨场景复现晋升规则，不以同一案例反复优化的最高分晋升；
- 固定运行预算，禁止失败后无限重采样直至偶然通过。
- 每次尝试写入同一 `experiment_ledger.family_id`，保留失败候选；最终候选使用未参与搜索的密封批次。

### 6. 审美同质化

Atlas 诊断的是结构性失败，不是在寻找唯一的“好文风”。修复如果让不同角色、题材和关系都趋向同一种克制、精致或高密度写法，同样属于退化。

每次回归至少检查：

- 角色间声音可区分度是否下降；
- 不同类型场景的节奏分布是否收窄；
- 原文中的粗粝、笨拙、沉默、重复或失控是否被无条件“润色”；
- 修订是否增加跨案例的库存短语与共同句法；
- 多个等价但异质的成功解是否仍能通过，而非只奖励一种成品感。

发现结构改善但多样性显著下降时，候选进入 `quarantined`，等待拆分规则或缩小适用范围，不能靠总分抵消。

---

## 六、分类法的机器提案（仅保留结构草案）

`verification_run.promotion_artifact` 已为多个未来目标定义类型化 payload，但当前确定性 Gate 只执行案例级 `repair_case`。`repair_strategy` 和 `taxonomy_proposal` 都会明确返回 `PROMOTION_TARGET_NOT_IMPLEMENTED`，不能得到 `adopted`；前者缺少跨独立留出案例的 applicability 证据，后者还缺少应用、迁移和回滚执行器。下面是未来启用分类法目标前仍必须满足的协议要求。

每个提案必须包含：

1. 在现有标签下无法解释或持续冲突的残差案例；
2. 与最近邻标签的正例、反例和最小对照；
3. 新边界可被机器重复识别的证据，而不只是新名称更顺口；
4. 对已有记录的迁移表：保留、重映射、歧义或不可迁移；
5. 新增冻结锚点与需要回放的旧锚点；
6. 对标签数量膨胀、重叠和因果循环的反方报告；
7. 语义版本变化与回滚方案。

分类法变更采用比普通修复更严格的双阶段验证：先证明现有分类法确实存在稳定残差，再证明新提案能减少残差且不损害旧边界。仅仅提高内部一致率不够，因为把多个不同失败合并成一个大标签也会提高一致率。

### 冻结锚点策略

锚点分为三层：

- **核心锚点：** 每个稳定标签的典型正例、明确反例和最近邻边界对。补丁版与次版本不得改写；破坏性修改只能随主版本另建，并继续保留旧锚点。
- **版本锚点：** 为某一 taxonomy / policy 版本冻结的完整回归集。新版本必须报告对旧版的逐项变化，不能静默替换。
- **影子锚点：** 不向生成器、诊断器和修复器公开，只在验证阶段由编排器调用。被泄露或反复使用后标记污染并轮换。

机器可以生成锚点候选，但“规则提案”和“使它通过的锚点提案”必须来自隔离运行，并分开晋升。当前候选无权删除自己失败的锚点。

---

## 七、停止条件

一次运行满足任一条件即停止，不继续搜索“终于能过”的版本：

### 成功停止

- 案例级候选在一份可追溯验证记录中完成 policy 要求的全部 repeat，Gate 对该 `repair_case` 返回 `adopted` 且记录声明 `promoted`；是否实际进入线上或持久化状态由外部编排器决定；或
- 单例修复已被证实有效并保留为案例；在跨独立留出案例证据进入协议前，不得把它升级为通用 `repair_strategy`。

### 无改善停止

- 达到预先设定的修复次数或计算预算；
- 连续若干候选没有超过最小实际改善幅度；
- 修复只能通过删减内容、弱化冲突或统一文体来降低目标标签；
- 新样本无法复现目标失败。

停止条件使用结构化 `condition_code`、预算动作和触发来源，并在 diagnostic、repair、verification 三份记录中逐字一致；Gate 不接受运行结束后替换停止规则。

### 隔离停止

- 诊断与对抗复核对场景契约存在不可消解分歧；
- judge 只有 I0 独立性，或出现任何顺序敏感；
- 锚点、匿名映射或影子测试已经污染；
- 候选在两个以上策略之间循环退化；
- taxonomy 版本或运行来源无法追溯。

### 回滚停止

以下条件是 policy 中受签名保护的回滚声明；当前仓库不持续监控已部署策略，也没有自动恢复旧版本的执行器：

- 已晋升策略触发硬性回归；
- 新证据证明原晋升依赖位置、长度、同源偏差或泄露；
- 新版在旧版冻结锚点上发生未声明的语义变化。

停止不是失败管理的附注，而是防止机器自我说服的核心机制。

---

## 八、建议的启动配置

在尚未积累实测数据时，可用以下配置启动；它们是保守的工程默认值，不是假装具有普适统计意义的真理：

- 2 个隔离诊断上下文 + 1 个对抗复核上下文；
- 至少 2 套实质不同的 judge 提示族；
- 每个候选至少执行 2 个顺序 × 2 个独立 repeat × 2 个独立 judge，共 8 次成对判断；
- 8 次判断属于一份验证记录，不得伪装成 8 个独立 judge；
- 每个 judge × repeat 的两个顺序都必须选择修订版；原版胜出、平局或换序反转都不能由其他票抵消；
- 任一硬性回归、锚点失败或位置反转超标，候选不得晋升；
- repeat manifest 必须保存不同 seed 与运行摘要；达到 policy 下限前，Gate 只允许记录声明 `probation`，实际状态迁移由外部编排器完成；
- 每条通用规则应由外部策略存储保留上一稳定版本和回滚目标；当前仓库只校验相关声明，不提供“一键回滚”执行器。

首批运行的目标不是尽快积累“成功规则”，而是先验证记录是否完整、盲化是否真实、失败能否被系统诚实地保留。一个会拒绝错误晋升的机器系统，才具备继续演化的资格。
