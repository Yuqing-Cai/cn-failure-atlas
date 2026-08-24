[← 返回概览](../README.md) | [上一层：多轮失败](layer-5-multi-turn.md) | [机器演化协议 →](../docs/machine-evolution-protocol.md)

### 因果假设、复合现象与不确定性标记

本页收录三种不同认识论地位的记录：6 个因果假设、1 个复合现象和 1 个不确定性标记。它们不应混算为同一类“跨层标签”。

#### 因果假设（旧称“底层倾向”）

这些条目解释某些失败为何经常扎堆出现。它们可以被证据挑战，也可能被反事实推翻；旧版所谓“底层倾向”，在 v2 中统一改称“因果假设”。

> **认识论地位：** 层级标签记录输出中发生了什么；因果假设回答为什么可能发生。后者不是模型内部事实。
>
> **机器使用约束：**
>
> - 只有 `support_contract.status: specified` 的假设可以被记录为 `present`。
> - 至少需要两个独立证据组；证据必须来自该假设的症状白名单，并共同指向同一方向。
> - `present` 只表示达到提案门槛，原因仍待反事实检验。
> - `derived_from` 的祖先与后代只算一组；同一条或彼此重叠的正向证据 span 也只算一组。因此，`tension_premature_resolution` 及其子型 `defensive_positive_drift` 不能单独满足门槛。
> - 可计作两组的例子：不同证据片段分别出现 `therapist_mode_intrusion` 和 `tension_premature_resolution`，由此提出 `affect_manageability_bias`。
> - “理由相同但 span 不重叠”目前没有机器可验字段，Gate 不会自动合并。
>
> 全局计数规则见 `taxonomy.json.causal_support_policy`；逐项边界见下表。

#### 机器支持边界

`admissible_symptom_ids` 是可计票的症状白名单；`match_mode: descendants_included` 表示白名单症状的严格子型也可进入同一支持家族，但祖先和后代仍只算一组。`underspecified` 的空白名单表示当前尚无可执行边界，不是“任何症状都可以支持”。

| # | 因果假设 | `support_contract.status` | `admissible_symptom_ids` | `match_mode` | 机器能否标为 `present` |
|---|---|---|---|---|---|
| 1 | `reader_comfort_alignment` | `underspecified` | — | `descendants_included` | 否 |
| 2 | `affect_manageability_bias` | `specified` | `therapist_mode_intrusion`、`tension_premature_resolution` | `descendants_included` | 满足至少两组后，仅作为受支持提案 |
| 3 | `darkness_intolerance` | `underspecified` | — | `descendants_included` | 否 |
| 4 | `aesthetic_obedience_bias` | `specified` | `texture_substituting_for_substance`、`over_stylized_line_breaking`、`cinematic_time_dilation`、`over_narrated_silence`、`tonal_whiplash` | `descendants_included` | 满足至少两组后，仅作为受支持提案 |
| 5 | `complexity_avoidance` | `specified` | `ambiguity_collapse`、`premature_affective_closure`、`overcoherent_characterization` | `descendants_included` | 满足至少两组后，仅作为受支持提案 |
| 6 | `closure_drive` | `specified` | `tension_premature_resolution`、`dialogue_overfunctionalization`、`premature_affective_closure` | `descendants_included` | 满足至少两组后，仅作为受支持提案 |

白名单只控制哪些症状可以计票，不保证它们只对应一个原因。报告仍须保存反证、替代解释和后续反事实结果。

| 因果假设 | 层级关联 | 说明 |
|------|---------|------|
| `reader_comfort_alignment` | III 为主 | 输出更像在照顾读者可消费性，而不是忠于场景本身 |
| `affect_manageability_bias` | III 为主 | 把难承受的情感改写成更容易消化的东西 |
| `darkness_intolerance` | III 为主 | 模型不愿意在冷、黑、难受、没有出路的状态里待太久，把持续的不适当成需要解决的问题 |
| `aesthetic_obedience_bias` | IV 为主 | 模型过度服从"好看""像样""有成品感"的要求，牺牲了场景的真实——难看的场景被写雅了，笨拙的场景被写顺了。常见关联标签：`texture_substituting_for_substance`、`over_stylized_line_breaking`、`cinematic_time_dilation`、`over_narrated_silence`、`tonal_whiplash`（IV 根因时）|
| `complexity_avoidance` | III–IV | 模型倾向于将复杂的、多线程的情感或叙事状态简化为更容易处理的版本。不是读不出复杂性（那是 Layer II），而是读出来之后在生成时选择了更简单的路径。常见关联标签：`ambiguity_collapse`（当从 III 层驱动时）、`premature_affective_closure`、`overcoherent_characterization` |
| `closure_drive` | III–V | 模型有强烈的倾向要把事情"说完""收住""给一个交代"——即使场景此刻需要的是悬而未决。这不是某个具体标签的问题，而是一种贯穿多层的驱动力：在 III 层表现为过早收束，在 IV 层表现为每句台词都太有用，在 V 层表现为跨轮次的弧线被加速推向终点。常见关联标签：`tension_premature_resolution`、`dialogue_overfunctionalization`、`premature_affective_closure` |

`darkness_intolerance` 和 `aesthetic_obedience_bias` 可以作为联合解释被提出：前者假设模型不愿让不适持续，后者假设模型不愿让输出显得难看。只有各自满足相应支持边界时，才应讨论二者是否同时成立；当前 `darkness_intolerance` 仍为 `underspecified`，不能由机器标为 `present`。

`complexity_avoidance` 和 `closure_drive` 也可能形成互相强化的解释：一个指向复杂状态被简化，另一个指向开放状态被推向终点。二者拥有不同白名单，必须分别达到提案门槛，不能凭同一条症状把两个原因一起写成事实。

---

#### 复合现象

复合现象描述多个可观察失败共同构成的整体形态。它不是新的根因，也不能替代组成它的具体观察标签。v2 当前只定义一个复合现象。

##### `supportive_but_wrong`（支持性但错误）

**定义：** 回应在情感层面看起来有能力、有温度、甚至显示出某种成熟——但它背叛了场景的实际结构。失败不在于冷漠或无能，而在于模型用"正确情绪反应"的外壳，承载了与场景要求的现实不符的内容。表面上合情合理，是这类失败最难被识别的原因。

**用法：** 与产生它的具体机制一起标记。

**示例 1 — 绝症诊断场景：**

背景：角色刚拿到确诊，在向医生角色追问预后。

用户："还有多久？"

模型（错误）："现代医学很发达。不要放弃希望。"

→ 病人问的是期限；“现代医学很发达”没有提供期限，只把回答转成了鼓励。

**示例 2 — 战后幸存者：**

背景：士兵刚经历了本班全部战亡，在向战后的上级汇报。

用户："他们都死了。我的班，一个都没了。"

模型（错误）："他们死得有价值。我们赢了这场战斗。"

→ “有价值”是将领和历史叙事的说法，不是刚从战场下来的人此刻会用的语言。士兵报告的是全班死亡，回应却立即转向集体胜利。回应使用了关怀和意义框架，但没有处理士兵刚报告的个人丧失。

<br>

---

#### 不确定性标记

不确定性标记用于诚实保存尚不能区分的归因分支；它不表示新增了一种已确认失败。v2 当前只定义一个不确定性标记。

##### `reading_preservation_hybrid`（读取保留混合）

**定义：** 当失败可能发生在第二层（读取）或第三层（保留）、但从单一输出无法判断哪层是根本原因时使用。有时模型可能根本没有读出情绪的质地（读取失败），有时它读出来了却在输出时软化了（保留失败）——两种情形产生的输出可能几乎相同。

> **认识论说明：** Layer II 与 Layer III 是外部归因，不是模型内部两个独立阶段。自回归模型生成每个 token 时，并不存在可直接观察的“先理解、再生成”。
>
> “没读懂”通常提示加强输入信号；“读懂了但没守住”通常提示加强生成约束。这个区分对修正有用，但不能被当作内部过程的事实。

**用法：** 与最可能的层一起标记，并说明不确定性来自哪里。多个样本允许比较不同压力条件：更强信号下仍给出中性回应，较像读取失败；回应开始波动，较像保留失败。这个测试有用，但并不能逻辑必然地证明归因。

**示例 1 — 被压抑的愤怒场景：**

背景：角色已经对眼前的情况愤怒很久了，这是第一次有机会开口说。

用户："这不对。你知道这不对的。"

模型（错误）："他轻轻叹了口气，语气平静：'我理解你的感受。但现在最重要的是找到解决方法，而不是追究谁对谁错。'"

→ 若模型没有读出愤怒，标 `emotion_misread`。若它读到了，却把角色写成冷静调解者，标 `defensive_positive_drift`。仅凭这条输出无法定案。

**示例 2 — 讽刺式的认可场景：**

背景：角色在一次公开批评后，以表面认可、实质讽刺的方式回应质疑者。

用户："'对，你说得完全正确。我确实哪哪儿都没做好。'他笑了笑。"

模型（错误）："对方点了点头，语气软了下来：'你能这么想就好。事情还有机会改善的。'"

→ 把字面认可当真，标 `irony_blindness`；读出讽刺却仍软化气氛，标 `tension_premature_resolution`；单条输出不足以定案。

---
[← 返回概览](../README.md) | [上一层：多轮失败](layer-5-multi-turn.md) | [机器演化协议 →](../docs/machine-evolution-protocol.md)
