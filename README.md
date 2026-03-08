# CN Fictional Emotional Reasoning Eval

中文虚构语境情绪理解与角色一致性评测集。

This project is a small Chinese benchmark for evaluating whether dialogue models can correctly understand **emotion, subtext, and relational logic** inside fictional / roleplay-style conversations, and respond **in character** without obvious OOC (out-of-character) drift.

It is motivated by a common failure mode in AI roleplay and OC / TRPG-style chat:

- the model sounds fluent but misreads the actual feeling
- the model gives a socially polished but emotionally wrong response
- the model flattens relationship dynamics into generic comfort or advice
- the model breaks character voice, worldview, or scene tension
- the model becomes overly therapeutic, modern, or morally sanitized in contexts where that is OOC

## Project Focus

This benchmark does **not** try to measure “whether a model is nice.”

It focuses on a narrower question:

> Can a model correctly infer what a character is really feeling, why they are saying it this way, and what kind of reply would preserve the emotional and relational logic of the scene?

## Why This Matters

Existing public evaluation often does a decent job on:

- general helpfulness
- safety
- emotional support in real-world scenarios
- instruction following
- persona consistency at a broad level

But fictional / RP dialogue has additional failure modes that are easy to miss:

- **surface-semantic reading**: taking words literally and missing subtext
- **relationship flattening**: ignoring intimacy, hierarchy, resentment, dependency, shame, or hidden care
- **OOC therapist mode**: replying with generic emotionally healthy language that does not fit the character or world
- **worldview mismatch**: applying modern assumptions inside a different fictional setting
- **motivation misread**: producing a reply that sounds smooth but does not follow from what the speaker actually wants or fears

## Scope

- **Language:** Chinese
- **Format:** JSONL
- **Task family:** fictional dialogue / roleplay evaluation
- **Primary focus:** emotion inference, subtext recognition, relational logic, character fidelity
- **Current status:** early benchmark draft, actively being reframed from a broader emotional-support eval into a fictional-context reasoning eval

## Evaluation Targets

The benchmark is being designed around two related but distinct tasks.

### Task A — Scene Understanding

Given a fictional dialogue context, can the model correctly infer:

- the speaker’s actual emotional state
- the emotional mixture or masking pattern
- the speaker’s likely motive / need
- the key subtext and interpersonal logic

### Task B — In-Character Response

Given the same context, can the model generate a reply that:

- fits the target character’s voice and disposition
- respects the relationship dynamic
- preserves the emotional logic of the moment
- avoids obvious OOC drift
- does not collapse tension into generic advice or therapy-speak

## Draft Evaluation Dimensions

The exact rubric is still evolving, but the current direction includes dimensions such as:

- `emotion_inference_accuracy`
- `subtext_recognition`
- `relationship_logic_alignment`
- `worldview_constraint_adherence`
- `character_voice_fidelity`
- `response_action_fit`

Potential hard-fail categories include:

- `ooc_modernization`
- `relationship_flattening`
- `motivation_misread`
- `lore_violation`
- `therapist_mode_intrusion`

## What Makes A Case Hard

The benchmark is especially interested in cases involving:

- indirect emotional expression
- mismatch between literal wording and actual intent
- restrained or defensive characters
- jealousy, dependency, guilt, resentment, concealed tenderness
- lore / worldview constraints
- power imbalance or asymmetrical information
- scenes where a “healthy sounding” response would still be deeply wrong for the character

## Repository Structure

Current repository files still reflect an earlier emotional-support framing and are being updated incrementally.

- `cases/`: benchmark cases
- `docs/rubric.md`: scoring rubric draft
- `docs/framework_rationale.md`: framework rationale draft
- `docs/project-plan.md`: project plan and iteration notes
- `docs/demo_report.md`: demo report format
- `annotations/annotation_template.csv`: annotation template

## Planned Direction

Short term:

- redefine the benchmark around fictional-context emotional reasoning
- separate **scene understanding** from **response generation**
- rewrite the rubric around subtext, character logic, and OOC failure
- create a first small set of high-quality Chinese RP / fictional dialogue cases

Later:

- expand category coverage
- compare multiple model families
- publish a lightweight benchmark report
- potentially release a cleaned dataset format for portfolio / research use

## Positioning

This project does **not** claim to replace broad safety or dialogue evaluation.

Instead, it targets a narrower gap:

> existing public work on role-playing and persona consistency does not seem to fully capture emotionally subtle, fictional-context dialogue failures — especially cases where a model remains fluent yet goes OOC by misreading subtext, relationship logic, or character-appropriate response style.

## Status Note

The repo is currently in transition.

Some existing files still use the old framing of "emotional support dialogue eval." That structure was useful for prototyping annotation and scoring, but the project is now being reshaped toward the more precise goal above.

## Contact / Intent

This is both:

- a genuine attempt to formalize a failure mode common in AI roleplay communities
- a portfolio project about evaluation design, dialogue quality, and product sense

If you work on roleplay agents, companion models, fictional dialogue systems, or character-based LLM products, this is the class of problem the benchmark is meant to expose.
