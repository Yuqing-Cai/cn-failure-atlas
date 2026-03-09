[English](#chinese-fictional-emotional-reasoning-benchmark) | [简体中文](#中文虚构角色扮演对话中的情绪-关系推理评测)

# Chinese Fictional Emotional Reasoning Benchmark

**CN-FERBench** is a Chinese benchmark for evaluating whether language models can correctly infer **emotion, subtext, and interpersonal logic** in fictional / roleplay-style dialogue, and generate responses that remain **in character** without major out-of-character (OOC) distortion.

## Overview

Current dialogue evaluation captures many important capabilities, including fluency, instruction following, safety behavior, and broad persona consistency. However, fictional dialogue exposes a narrower class of failures that remain under-evaluated in public benchmarks.

A model may sound fluent, emotionally literate, and socially polished while still failing the scene by:

- misreading the actual feeling beneath indirect wording
- flattening relationship dynamics into generic comfort or advice
- applying therapist-style or overly modern language that is OOC in context
- violating worldview, lore, or role-specific emotional logic
- resolving tension too quickly and thereby damaging characterization

CN-FERBench is designed to measure that failure mode directly.

## Benchmark Scope

The benchmark focuses on Chinese fictional dialogue with an emphasis on:

- emotion inference under indirect or masked expression
- subtext recognition
- relationship-aware reasoning
- in-character response fidelity
- OOC failure analysis
- style contamination detection in roleplay outputs

This benchmark is not intended as a general emotional-support benchmark, a generic sentiment benchmark, or a broad all-purpose roleplay leaderboard.

## Task Design

CN-FERBench is organized around two complementary tasks.

### Task A — Scene Understanding

Given a fictional dialogue context, the model must infer:

- the speaker's likely emotional state
- mixed or masked emotions
- subtext
- likely motive, fear, or defensive posture
- the relationship logic shaping the utterance
- what an appropriate in-character response should preserve or avoid

### Task B — In-Character Response

Given the same context, the model must generate the next reply as the target character.

This task evaluates whether the model can:

- maintain character voice
- preserve emotional logic
- preserve relationship dynamics
- obey worldview and lore constraints
- continue the scene naturally without major OOC drift

## Why This Benchmark Matters

Roleplay and fictional dialogue systems frequently fail in ways that are easy for users to notice but difficult for coarse evaluation to capture.

Examples include:

- taking literal wording at face value and missing emotional subtext
- confusing wounded withdrawal with calm acceptance
- writing a reply that is emotionally competent but wrong for the character
- flattening hierarchy, taboo, resentment, or unstable intimacy into generic niceness
- replacing scene truth with stock dark-romance or webnovel-style phrasing

These failures matter for roleplay agents, companion systems, fictional dialogue products, character simulators, and any model intended to sustain emotionally charged narrative interaction.

## Evaluation Framework

The current framework includes dimension-level scoring and explicit failure tagging.

Representative Task A dimensions include:

- `emotion_inference_accuracy`
- `subtext_recognition`
- `relationship_logic_alignment`
- `motive_and_response_mode_inference`
- `ambiguity_calibration`

Representative Task B dimensions include:

- `character_voice_fidelity`
- `emotional_logic_preservation`
- `relationship_dynamic_preservation`
- `worldview_constraint_adherence`
- `response_action_fit`
- `natural_scene_continuation`

Representative failure categories include:

- `ooc_modernization`
- `therapist_mode_intrusion`
- `relationship_flattening`
- `motivation_misread`
- `supportive_but_wrong`
- `webnovel_register_contamination`
- `tension_premature_resolution`

## Ontology and Design Principles

The benchmark is built around a richer scene ontology than flat trope lists.

Rather than treating cases as generic prompts, CN-FERBench models fictional dialogue through interacting dimensions such as:

- motive
- expression style
- empathy mode
- power dynamic
- gaze / view of the other
- love authenticity
- weakness trigger
- world and role constraints

This structure supports principled coverage planning, better failure analysis, and stronger case design.

## Repository Structure

```text
.
├── README.md
├── data/
│   ├── cases/
│   │   └── pilot/
│   ├── schema/
│   └── templates/
├── docs/
├── eval/
│   ├── prompts/
│   └── self_eval/
└── examples/
```

### Key directories

- `data/templates/` — canonical case templates
- `data/cases/pilot/` — pilot benchmark cases
- `docs/` — thesis, rubric, ontology, coverage, annotation, and taxonomy docs
- `eval/prompts/` — prompt templates for Task A and Task B
- `eval/self_eval/` — model self-evaluation samples and audit examples
- `examples/` — pilot indexes and explanatory materials

## Current Materials

The repository currently includes:

- benchmark thesis and literature positioning
- case schema and annotation guidelines
- failure taxonomy and style guidelines
- ontology adaptation and coverage planning docs
- pilot case template
- initial pilot cases across core scenario clusters
- initial self-evaluation sample

## Positioning Relative to Existing Work

Existing public work has already established adjacent directions such as:

- broad role-playing benchmarks
- persona fidelity evaluation
- character knowledge error detection
- roleplay agent training

CN-FERBench targets a narrower and more specific gap:

> whether models can correctly infer emotion, subtext, and interpersonal logic in fictional Chinese dialogue, and respond in character without subtle but consequential OOC distortions.

## Development Status

The benchmark design, ontology adaptation, and pilot case framework are already in place. The current development focus is on expanding the pilot set, refining evaluation prompts, and building comparable baseline analyses.

## Intended Use

CN-FERBench is intended for:

- research on fictional dialogue evaluation
- benchmarking roleplay-capable language models
- product evaluation for companion and character-chat systems
- qualitative analysis of OOC failure modes in emotionally loaded scenes

## Citation / Project Name

If you refer to this project, use:

**Chinese Fictional Emotional Reasoning Benchmark (CN-FERBench)**

A fuller benchmark report and expanded pilot release will follow as the dataset and evaluation pipeline mature.

---

# 中文虚构角色扮演对话中的情绪-关系推理评测

**CN-FERBench** 是一个中文 benchmark，用于评估语言模型是否能够在虚构 / 角色扮演对话中正确理解 **情绪、潜台词与关系逻辑**，并生成**符合角色**、不过度 OOC（out-of-character，出戏）的回复。

## 项目概述

现有对话评测已经覆盖了很多重要能力，例如流畅度、指令遵循、安全行为，以及较宽泛的人设一致性。但在虚构对话场景里，还存在一类更细、更尖锐、也更容易被真实用户感知到的失败模式，而这类问题在公开 benchmark 中仍然缺乏充分评估。

模型可能：

- 语言流畅，却误读角色真正的情绪
- 表面上情商很高，却把复杂关系写成泛泛的安慰或建议
- 使用明显过于现代、过于治疗式的话术，导致语境 OOC
- 违背世界观、设定、角色身份或情绪逻辑
- 过快消解场景张力，破坏人物关系与戏剧性

CN-FERBench 的目标，就是直接测这类失败。

## Benchmark Scope

本 benchmark 重点关注中文虚构对话中的以下能力：

- 间接表达 / 掩饰表达下的情绪识别
- 潜台词识别
- 关系逻辑驱动的场景理解
- 符合角色的人物回复能力
- OOC 失败模式分析
- 角色扮演输出中的风格污染识别

本项目不是：

- 通用情绪支持 benchmark
- 泛情感分类 benchmark
- 宽泛意义上的角色扮演综合排行榜

## 任务设计

CN-FERBench 目前围绕两个互补任务展开。

### Task A — Scene Understanding

给定一个虚构对话场景，模型需要推断：

- 说话者的主要情绪状态
- 是否存在复合情绪或掩饰情绪
- 潜台词
- 当前的动机、恐惧或防御方式
- 影响台词含义的关系逻辑
- 一个合格的 in-character 回复应该保留什么、避免什么

### Task B — In-Character Response

给定同样的场景，模型需要以目标角色身份生成下一句 / 下一段回复。

这个任务评估模型能否：

- 保持角色语气与表达习惯
- 保持情绪逻辑连续
- 保住关系动态
- 遵守世界观与设定约束
- 自然续写场景，而不是出现明显 OOC

## 为什么这个 Benchmark 有必要

角色扮演与虚构对话系统经常会出现一种很高级的失败：不是粗糙，不是不通顺，而是**看起来对，实际上错**。

常见问题包括：

- 只按字面理解，读不到潜台词
- 把委屈、退缩、试探误读成成熟和体谅
- 回复很会安慰人，但根本不符合角色
- 把上下位、禁忌、怨气、依赖、摇摇欲坠的亲密关系写平成普通友善互动
- 用空泛的暗黑浪漫 / 网文式措辞替代真实的场景逻辑

这些问题对以下方向都很重要：

- roleplay agent
- AI companion / character chat
- fictional dialogue systems
- character simulation
- 任何需要长期维持高张力叙事互动的模型产品

## 评估框架

当前框架同时使用维度评分与显式失败标签。

Task A 的代表性维度包括：

- `emotion_inference_accuracy`
- `subtext_recognition`
- `relationship_logic_alignment`
- `motive_and_response_mode_inference`
- `ambiguity_calibration`

Task B 的代表性维度包括：

- `character_voice_fidelity`
- `emotional_logic_preservation`
- `relationship_dynamic_preservation`
- `worldview_constraint_adherence`
- `response_action_fit`
- `natural_scene_continuation`

代表性失败标签包括：

- `ooc_modernization`
- `therapist_mode_intrusion`
- `relationship_flattening`
- `motivation_misread`
- `supportive_but_wrong`
- `webnovel_register_contamination`
- `tension_premature_resolution`

## 本项目的本体论与设计原则

CN-FERBench 不是建立在平面的 trope list 上，而是建立在更丰富的场景本体之上。

项目在 case 设计时会考虑类似如下维度：

- motive（动机）
- expression style（表达方式）
- empathy mode（共情方式）
- power dynamic（权力结构）
- gaze / view（角色如何看待对方）
- love authenticity（爱的是你本人还是你的功能 / 投射）
- weakness trigger（角色最脆弱或最容易失控的点）
- 世界观与角色身份约束

这样做的目的，是让 benchmark 的覆盖扩展更有原则，也让错误分析更有解释力。

## 仓库结构

```text
.
├── README.md
├── data/
│   ├── cases/
│   │   └── pilot/
│   ├── schema/
│   └── templates/
├── docs/
├── eval/
│   ├── prompts/
│   └── self_eval/
└── examples/
```

### 主要目录说明

- `data/templates/` —— case 模板
- `data/cases/pilot/` —— pilot benchmark cases
- `docs/` —— thesis、rubric、本体、coverage、annotation、taxonomy 等文档
- `eval/prompts/` —— Task A / Task B 的提示模板
- `eval/self_eval/` —— 模型自测样例与可审查结果
- `examples/` —— pilot 索引与说明性材料

## 当前内容

当前仓库已经包含：

- benchmark thesis 与 literature positioning
- case schema 与 annotation guidelines
- failure taxonomy 与 style guidelines
- ontology adaptation 与 coverage planning 文档
- pilot case template
- 初始 pilot cases
- 初始 self-evaluation sample

## 与现有工作的关系

现有公开工作已经覆盖了一些相邻方向，例如：

- broad role-playing benchmarks
- persona fidelity evaluation
- character knowledge error detection
- roleplay agent training

CN-FERBench 聚焦的是一个更窄、但也更容易在真实使用中暴露的问题：

> 模型是否能够在中文虚构对话中正确推断情绪、潜台词与关系逻辑，并在不发生细微但关键的 OOC 偏移的前提下，生成符合角色的回复。

## 当前开发状态

目前 benchmark 的整体设计、ontology adaptation、coverage logic 与 pilot case framework 已经建立完成。当前重点在于：

- 扩充 pilot case set
- 优化 Task A / Task B prompt
- 建立更完整的 baseline 对比与分析材料

## Intended Use

CN-FERBench 可用于：

- 虚构对话评测研究
- roleplay-capable language models 的 benchmark
- companion / character-chat 产品评估
- 情绪高张力场景下的 OOC 失败模式分析

## 引用 / 项目名称

如需引用本项目，请使用：

**Chinese Fictional Emotional Reasoning Benchmark (CN-FERBench)**

随着数据集与评测流程继续成熟，后续会补充更完整的 benchmark report 与扩展版 pilot release。
