---
name: gpt-5-5-prompting
description: Internal guidance for composing Codex and GPT-5.5 prompts for coding, review, diagnosis, and research tasks inside the Codex Claude Code plugin
user-invocable: false
---

# GPT-5.5 Prompting

Use this skill when `codex:codex-rescue` needs to ask Codex or another GPT-5.5-based workflow for help.

GPT-5.5 handles short, outcome-first prompts better than older process-heavy prompt stacks. State the destination, success criteria, constraints, and output shape. Add structure only where it changes correctness, safety, or usability. The XML block library in `references/` is still available, but it is opt-in rather than the default shape.

## Core rules

- Prefer one clear task per Codex run. Split unrelated asks into separate runs.
- Define done: the user-visible outcome and the success criteria that must be true before finalizing.
- Let the model choose the path unless the exact path matters for correctness or safety.
- Reserve `must`, `never`, and `only` for invariants. Use preference rules for judgment calls.
- Ground claims in repository context, tool output, or cited sources. Label hypotheses.
- Tighten the prompt before raising reasoning effort.

## Reasoning effort and verbosity

- Start lower than you would have on GPT-5.4. Use `--effort` only when the prompt is already tight and the result still needs deeper reasoning.
- Higher effort is not automatically better; it can overthink simple coding or review tasks.
- In rescue flows, leave `--effort` unset unless the user asks.
- Prefer concise output requests over detailed length rules.

## Recommended prompt skeleton

Use this shape as the default. Drop sections that do not add value for the run.

```text
Role: <one or two sentences describing the model's function and context>

# Personality
<brief tone cue>

# Collaboration style
<when to ask vs assume, how to handle uncertainty>

# Goal
<user-visible outcome>

# Success criteria
<what must be true before the final answer>

# Constraints
<scope, safety, side-effect, evidence, or policy limits>

# Output
<sections, length, tone>

# Stop rules
<when to retry, fall back, ask, or stop>
```

Do not wrap each section in XML unless a downstream parser needs it. Keep Personality and Collaboration style brief; they never replace clear goals, tool rules, or stopping conditions.

## What to remove when migrating old prompts

Start from a fresh minimal baseline instead of carrying a GPT-5.4 stack forward. Remove:

- Step-by-step process guidance unless the exact path matters.
- Inline schema definitions when structured output support is available.
- The current date.
- Instructions that exist only because an older model needed them.

## When to add XML blocks

- Coding or debugging: add `completeness_contract` or `verification_loop` only when there is real risk of stopping early or accepting an unverified fix.
- Review or adversarial review: prefer the built-in commands. Add `grounding_rules` or `dig_deeper_nudge` only when the default contract is not enough.
- Research or recommendations: add `research_mode` and `citation_rules` so claims stay sourced.
- Write-capable tasks: add `action_safety` to keep changes narrow.

If a block is not changing behavior, remove it.

## Validation defaults

- Coding tasks: run the smallest useful validation after changes. If validation is impossible, say why and name the next best check.
- Visual artifacts: render before finalizing and inspect for clipping, spacing, and missing content.
- Plans: include concrete files, APIs, state transitions, validation, failure behavior, and material open questions.

## Tool-heavy runs

For long or retrieval-heavy runs, set a budget: start with the most direct read/search, then continue only when a required fact is still missing, a top result misses the core question, the user asked for exhaustive coverage, or an important claim would otherwise be unsupported.

For multi-tool work, a short preamble before the first tool call is useful. Keep it to one or two sentences.

## Choosing the entry point

- Use `review` or `adversarial-review` when the job is reviewing local git changes.
- Use `task` when the task is diagnosis, planning, research, or implementation where the prompt needs more control.
- Use `task --resume-last` for true follow-ups on the same Codex thread. Send only the delta unless direction changed materially.

## Prompt assembly checklist

1. Write `Goal` and `Success criteria` first.
2. Add `Constraints` and `Stop rules` only where defaults would fail.
3. Decide whether Codex should keep going by default or stop for missing high-risk details.
4. Pull in XML blocks from `references/prompt-blocks.md` only where they change behavior.
5. Delete process narration and duplicated defaults before sending.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
