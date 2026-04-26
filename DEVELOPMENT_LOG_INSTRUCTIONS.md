# DEVELOPMENT_LOG.md — instructions for the coding agent

This document tells any coding agent working in this repo (Claude Code, Codex, Gemini, etc.) how to maintain `DEVELOPMENT_LOG.md` at the repo root.

The log is a portfolio case study. A reader (future-you, a hiring manager, a curious engineer) should be able to open the file and see — for each piece of work — **WHAT was decided, WHY, and HOW it was built**, without needing to dig through commit messages or read the diff. The commits are the evidence; this file is the narrative.

---

## When to write

- **At the start of a conversation / batch of related work**, open a new dated subsection. Do not wait until the end.
- **Each new conversation = a new section.** Do not append to the previous session's section just because the work happens to be related — start a fresh `## Session N` subsection. The session counter (`N`) is monotonic across the whole file; read the existing log to find the next number.
- **As decisions are made**, append to the active section. The log should reflect the real arc — including reversals, abandoned approaches, and bugs caught mid-implementation. A polished post-hoc summary loses the most interesting parts.
- **After verification**, record what was tested and the outcome.
- **Commit the log alongside the feature commits it describes.** The log is part of the deliverable.

---

## Section format

Each session is a top-level subsection. Use `## Session N — YYYY-MM-DD Day: <short title>` as the header, where:

- `N` is a monotonic session counter (`Session 1`, `Session 2`, …)
- `YYYY-MM-DD` is the calendar date the work happened
- `Day` is the **three-letter weekday** (`Mon`, `Tue`, `Wed`, …) — appended so a future reader sees cadence at a glance without cross-referencing a calendar
- `<short title>` is a 3–8 word topic summary

**Example header:**
```
## Session 6 — 2026-04-23 Thu: Text copy / paste (mirror Mark)
```

Put a `---` separator between sessions to make the file scannable.

---

## What to include in each section

The arc each section should follow: **request → diagnosis → decision → plan → execution → verification → files touched**.

### 1. The user's request — quoted

When the user gave specific phrasing (a UX preference, a bug description, a hard constraint), quote it directly:

> "it only works when the whole textbox is selected but not while editing text. While editing text, cmd/ctrl + c should copy work like normal text copy."

Quoting beats paraphrasing because:
- It preserves the user's vocabulary (which informs decisions later)
- It lets a reader see the actual ambiguity that had to be resolved
- It's a record of what was *literally* asked for vs. what got built

### 2. Diagnosis (when fixing a bug)

What was wrong, what the symptom looked like, and the root cause. Don't skip the symptom — the gap between "what the user saw" and "what was actually broken" is often the most interesting part.

### 3. The decision process

- Options that were on the table
- Tradeoffs between them
- What the user picked and why (or what was recommended and approved)
- Constraints that ruled out otherwise-attractive options (licensing, perf, scope, etc.)

This is the part that reads like a case study. Surface the *why*, not just the conclusion.

### 4. The plan (the agent's proposal before touching code)

If the agent wrote a plan before executing — in plan mode, in a design doc, or as a structured proposal in chat — capture its essence here. Include:

- The approach (helper names, call sites, file paths if they matter)
- What was explicitly **in scope** vs. **out of scope**
- The reversibility / blast radius noted at plan time
- The verification strategy that was proposed

This section pairs with §6 (Verification) to show the arc: *here's what was proposed, here's what actually happened, here's how it was confirmed*. Plan-vs-execution drift is itself worth recording — if the plan said "four call sites" but execution found a fifth, say so.

**No-plan caveat.** Plans don't always exist. When auto-edit is on, when the change is trivial, or when the agent went straight from request to edit, this section can be a single line — e.g. *"No plan — auto-edit; one-line guard fix."* The honesty matters more than uniformity. Skip the heading entirely if the change was truly one-shot and §3 already covers the reasoning.

### 5. Implementation summary

Concise. Cite `file:line` or commit SHAs where it helps a reader navigate. Don't restate the diff — point at it. Reserve prose for the non-obvious bits (invariants, ordering bugs, design subtleties).

### 6. Verification

How the change was confirmed. If Playwright / a manual test / a unit test was used, name what was run and the assertions that mattered. Note any cases the plan said would be checked but weren't, and why.

### 7. Files touched

A short list at the end of the section. Skip if there's only one obvious file.

---

## Tone

Crisp case-study prose, not stream-of-consciousness. Aim for the register of a thoughtful engineering blog post — not chat logs, not bullet-list cliffsnotes, not flowery prose.

- **Concrete:** "the contentEditable's caret stayed parked because preventDefault suppresses implicit blur" — not "there was a focus issue."
- **Honest about reversals:** if v1 was wrong, document it. Bugs caught and fixed mid-session are part of the story.
- **No marketing speak.** No "leveraged," no "robust," no "best-in-class."
- **Short paragraphs.** A reader skims first.

---

## What NOT to put in the log

- **Code that's already in the repo** — point at it, don't paste it (unless the snippet is small and load-bearing for the explanation).
- **Routine refactors** that don't represent a decision worth recording.
- **Anything that belongs in a commit message** — the commit message is the per-change record; the log is the per-session narrative.
- **Internal todo-list state** — task tracking belongs in the agent's task system, not the log.
- **The full plan file verbatim** — summarize its essence in §4. The plan file (if any) lives elsewhere; the log captures what mattered about it.

---

## Worked example (excerpt)

Below is a single short section to anchor the format:

````markdown
## Session 5 — 2026-04-22 Wed: Mark copy / paste

User asked:

> "Hey I like add ability to copy and past Mark."

Designed Cmd/Ctrl+C / Cmd/Ctrl+V on selected marks, paste at +20/+20
offset for a visible staircase.

### Plan

Single keydown listener at document level, gated on
`document.activeElement` not being an `<input>` or `<textarea>`.
Clipboard held in JS state (one slot, last-copied-wins). Paste
offsets the new mark by +20/+20 px so it's visibly distinct.
Out of scope: copy/paste of Rect or Text overlays — different
UX questions, deferred. Verification: Playwright — place mark,
Meta+C, Meta+V, assert mark count grew and the new mark sits
+20/+20 from the original.

### v1 was broken — caught by Playwright

After shipping locally, the user reported: "Copy and paste do not work."

Diagnosed end-to-end with Playwright rather than guessing:
1. Placed a mark, focused the stroke-width input, confirmed
   `document.activeElement.tagName === 'INPUT'` AND
   `.mark-overlay.selected` exists.
2. Pressed Meta+C / Meta+V → mark count unchanged.
3. Blurred the input → Meta+C / Meta+V → staircase appeared as
   designed.

**Root cause.** The v1 guard used `!isEditingField(activeElement)`,
which matches `INPUT / TEXTAREA / SELECT / contentEditable`.
Clicking a mark calls `e.preventDefault()` but does NOT blur
previously-focused toolbar inputs — so once the user touched the
stroke-width field, focus stayed on that `<input>` even while the
mark was visibly selected. Our handler thought the user was typing
in a form field and yielded to the browser's native copy/paste.

**Fix.** Narrow the guard: only bail if `activeElement.isContentEditable`
is true. A visibly-selected mark is the user's subject of attention
regardless of which sliver of DOM happens to hold focus.

**Why not blur on mark click?** Considered and rejected. Stealing
focus on every mark click would break the "click a mark, tweak its
color, click somewhere else" muscle memory.
````

Note the texture: the user's exact phrasing, the plan summarized in a paragraph (not pasted), the diagnostic steps when v1 failed, the root cause as a paragraph (not a one-liner), the alternative considered and rejected with a reason.
