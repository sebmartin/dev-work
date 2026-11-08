---
name: design
description: Works out a thread todo's design with the user through superpowers:brainstorming, saved as an artifact in the thread and linked from the todo, ready for /dev-work:develop. Use when the user types /dev-work:design or asks to design a todo for dev-work.
---

# dev-work: design

The one step done with the user. `superpowers:brainstorming` runs as it is, with the user's preferences below, which its own rules let override its defaults.

## Before

- **Task:** a thread todo stating the intent. Work in its thread (resume it with the ai-workspace threads skill if it isn't already), so the conversation can draw on the thread's notes and decisions.
- Set the todo's state to `started` when you pick it.
- If the todo already links to a design, brainstorm from that design and update it in place.

## Brainstorm

Use `superpowers:brainstorming` on the todo's intent, with these preferences:

1. **Where the design goes:** an artifact in the todo's thread, following the ai-workspace threads conventions for artifacts, never in the repository. Commit nothing to the repository.
2. **What it holds:** brainstorming's written design (intent and why, goals and non-goals, constraints, the decided parts of the how, what's left to the builder), the acceptance criteria, the target repository and branch if known, and a closing `## Decision log` section, empty to start, where later rulings that change the design are recorded with their reason.
3. **When to write it up is the user's call alone.** Keep track of what is still open. While anything is open, keep working through it with the user and don't bring up writing. Once nothing is open, you may ask once whether to write the design up, then wait. Never announce that you're starting, never start because you think it's ready, and never take an answer to a different question as the go-ahead. You don't need to show the whole design afterwards.
4. **After approval:** don't invoke `superpowers:writing-plans`. Planning starts with `/dev-work:develop`.

The design is read by agents that never see the thread, so it has to stand on its own: no references to notes, sessions or other artifacts, and no paths into the workspace or a thread. When the builder needs a file from the thread (data, fixtures, examples), the design names it only as an input, `inputs/<name>`, with a line on what it is; the todo's Inputs list says which thread file it is, and develop stages it.

When the builder check changes the design, reread the whole document before handing it over, and fix anything those changes left stale.

## After

1. Leave the todo as the intent plus a one-line link to the design. If the todo carried design content of its own (sections on how to build it, acceptance criteria), that content now lives in the design: remove it from the todo, so there is one source.
   If the design names inputs, add an `## Inputs` list to the todo, one line per input: `inputs/<name>` ← the thread file it comes from.
2. Save the thread's session with the ai-workspace threads skill, without asking: the user is about to leave this conversation.
3. Tell the user the design is ready and the session saved, and that the next step is `/dev-work:develop <todo>` in a session started in a directory that contains the repository (the folder that holds their repositories, or the repository itself), with this thread resumed. If this session started in such a directory, it can run develop now; otherwise they start a new session there.
