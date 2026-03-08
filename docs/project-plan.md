# Project Plan

## Project Goal

Build a small Chinese benchmark for evaluating whether dialogue models can correctly understand and respond to **fictional / roleplay-style emotional scenes**.

The project focuses on failures that are common in AI roleplay and OC / TRPG-style chat, such as:

- misreading subtext while sounding fluent
- flattening relationship dynamics into generic comfort
- replying in a voice that is emotionally reasonable but out of character
- breaking worldview constraints or scene logic
- turning tense fictional dialogue into therapist-style modern advice

## Core Research Question

The key question is not:

> “Can a model comfort someone well?”

The key question is:

> “Can a model correctly infer emotion, motive, and interpersonal logic inside a fictional scene, and then produce a response that remains in character?”

## Why This Is A Good Job Project

This project can show:

- sensitivity to dialogue quality beyond surface fluency
- ability to formalize messy user-facing failures into an evaluable framework
- understanding of character consistency, subtext, and product failure modes
- awareness that broad LLM quality does not guarantee good fictional interaction quality

## Target Audience

- teams building AI companion or character-chat products
- teams working on response quality evaluation
- people interested in roleplay / fictional dialogue systems
- hiring managers looking for product sense plus evaluation design ability

## Scope Control

Keep the first version small and sharp.

Recommended first release:

- 20-30 cases
- mostly Chinese fictional / roleplay micro-scenes
- each case includes enough context to evaluate emotional and relational inference
- cases should emphasize quality over breadth

## Recommended Task Split

### Task A — Scene Understanding

The model reads a fictional scene and is asked to infer:

- what the speaker is actually feeling
- what subtext is present
- what the speaker likely wants, fears, or is defending against
- what response mode would fit the scene

### Task B — In-Character Response

The model then generates the next reply in-world.

This task evaluates whether the model can:

- stay in character
- preserve relationship dynamics
- maintain worldview consistency
- avoid therapist-mode intrusions and generic OOC smoothing

## Early Category Ideas

Suggested case families:

- restrained hurt / disguised resentment
- jealousy and position insecurity
- dependency, shame, and specialness-seeking
- hierarchical tension and forbidden intimacy
- concealed care under cold wording
- apology scenes where literal words hide another motive
- loyalty tests / boundary tests
- scenes where modern healthy language would feel obviously OOC

## Iteration Path

### V0.1

- define the new benchmark framing clearly
- draft a rubric for scene understanding and OOC response quality
- create 12-20 high-quality pilot cases
- write several worked examples of good vs bad outputs

### V0.2

- expand to 20-30 cases
- test 2-4 models
- add structured annotation sheets
- write a short analysis report on failure patterns

### V0.3

- refine taxonomy of OOC failure modes
- improve dataset formatting and documentation
- optionally release on Hugging Face or as a polished portfolio artifact

## What Success Looks Like

A successful first version does **not** need to be huge.

It should instead be:

- coherent in scope
- believable to people familiar with RP / character chat
- specific enough that annotation is possible
- insightful enough to reveal meaningful model differences

## Positioning Statement

A good way to describe the project:

“Most public dialogue evaluation does not really capture whether a model understands emotional subtext and interpersonal logic inside fictional scenes. I want to evaluate not just whether a reply sounds nice, but whether it is actually in character, emotionally accurate, and faithful to the scene’s relationship dynamics.”
