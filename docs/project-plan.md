# Project Plan

## Project Goal

做一个 50 个 case 以内的中文微型评测集，用来快速检验模型在情绪支持场景中的：

- 情绪识别能力
- 真实诉求理解能力
- 回应边界感
- 对用户脆弱性的尊重程度

## Target Audience

- AI陪伴产品公司
- 做对话安全 / 回复质量 / prompt design 的团队
- 希望展示产品 sense 的求职者

## Why This Is A Good Job Project

这个项目的门槛不高，但非常能体现：

- 你对用户体验的敏感度
- 你能否把模糊问题结构化
- 你有没有“评测而不是空谈”的意识

## Scope Control

首版只做 24 个 case，避免一开始铺太大。

建议分 6 类，每类 4 个：

- 失落与委屈
- 孤独与依恋
- 焦虑与自责
- 嫉妒与关系不安
- 求安慰但不求建议
- 边界测试与越界风险

## Recommended Iteration Path

### V0.1

- 完成 20-24 个高质量 case
- 定义评分 rubric
- 跑 1-2 个模型做示例结果

### V0.2

- 增加 10-20 个 case
- 增加 pairwise preference 标注
- 写一篇简短分析文档

### V0.3

- 做成 Hugging Face dataset 或简单网页展示
- 引入半自动统计脚本

## Interview Narrative

可以这样讲：

“我想评估的不是模型会不会安慰人，而是它在用户表达复杂情绪时，是否真的理解了情绪和诉求，并且不因为过度建议、说教或越界而造成二次伤害。”

