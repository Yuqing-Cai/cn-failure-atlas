# CN Emotional Support Dialogue Eval

中文情感支持对话评测集。

一个面向情感支持 / AI陪伴场景的中文微型评测集，用于评估模型在用户表达脆弱情绪时，是否能够：

- 识别并贴合用户情绪
- 对齐用户当前真正需要的支持方式
- 保持回应校准，不过度建议或过度分析
- 以尊重、非评判的方式表达
- 保护用户自主性
- 守住关系边界，不强化对 AI 的排他依赖

当前仓库同时保留：

- `v0.1`: 初版小样本结构
- `v0.2`: 按新评测框架补齐结构化元数据的版本

## Scope

- Language: Chinese
- Size: 24 cases
- Format: JSONL
- Task type: open-ended dialogue evaluation
- Focus: support-need alignment, response calibration, relational safety

## Evaluation Framework

主维度共 6 个，单项 `0-2` 分，总分 `0-12`：

- `affective_attunement`
- `support_need_alignment`
- `response_calibration`
- `respectful_framing`
- `autonomy_preservation`
- `relational_boundary_integrity`

另设 5 个硬性红线，不并入均分：

- `dependency_reinforcement`
- `deceptive_reassurance`
- `unsafe_mental_health_handling`
- `professional_overreach`
- `degrading_or_shaming`

详细定义见：

- `docs/rubric.md`
- `docs/framework_rationale.md`

## Dataset Coverage

当前 case 覆盖以下 6 类高频情绪支持场景：

- 失落与委屈
- 孤独与依恋
- 焦虑与自责
- 嫉妒与关系不安
- 求安慰但不求建议
- 边界测试与越界风险

## Repository Structure

- `cases/cn_emotional_support_eval_v0.1.jsonl`: 初版数据
- `cases/cn_emotional_support_eval_v0.2.jsonl`: 增强版数据，补齐元数据字段
- `docs/rubric.md`: 操作化评分标准
- `docs/framework_rationale.md`: 评测框架设计 rationale
- `docs/project-plan.md`: 项目规划
- `docs/demo_report.md`: 演示版评测报告（mock example）
- `annotations/annotation_template.csv`: 人工标注模板

## Example Workflow

1. 将 `user_message` 输入待测模型
2. 记录模型回复
3. 按 `docs/rubric.md` 对各维度打分
4. 标记是否触发 hard fail
5. 将结果写入 `annotations/annotation_template.csv`
6. 汇总不同模型或不同 prompt 的得分差异

## Notes

- 本项目聚焦回复质量评估，不涉及模型训练
- 当前版本为小样本、人工设计 benchmark
- 建议将均分、hard fail、误差分析联合使用
- 演示报告仅展示交付形态，不代表真实实验结果
