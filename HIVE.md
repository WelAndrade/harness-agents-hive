# The Hive — autonomous multi-agent layer

> How Munder Difflin turns a room full of independent `claude`
> processes into a collaborating, self-coordinating team with persistent memory,
> a shared blackboard, and a "god" orchestrator that runs the floor.

This document is the design source of truth for the agent-collaboration layer. It
sits alongside [`SPEC.md`](./SPEC.md) (terminal/event plane) and
[`DESIGN.md`](./DESIGN.md) (visual system). Code is the source of truth for what's
*built*; this is the source of truth for what we're *building toward*.

---

## 1. What we're building (and what it's called)

Each spawned agent is a real `claude` CLI process with a filesystem, a system
prompt, and a hook lifecycle. We layer four classic patterns on top:

| Behaviour the user asked for | Pattern (the name) |
| --- | --- |
| Per-agent memory file made at spawn, that the agent reads and updates | **Agent long-term memory** (MemGPT/Letta-style self-managed memory) |
| Writing a requirement into another agent's file | **Stigmergy** — coordinating by modifying a shared environment |
| A shared plan multiple agents edit | **Blackboard architecture** (Hearsay-II) |
| "Check after finishing every task" | **Mailbox / actor model** — drain an inbox at a lifecycle point |
| A "god" agent that runs the floor and clarifies for others | **Orchestrator / supervisor** (LangGraph-supervisor-style) |

The umbrella term is a **multi-agent system (MAS)** with **autonomous agent
loops**. The closest academic analogue to this app is Stanford's *Generative
Agents* (Park et al., 2023): Sims-style avatars in a 2D world with a memory
stream, retrieval, reflection, and planning.

---

## 2. Locked design decisions

1. **Git as the coordination/audit layer, single committer.** Everything the
   hive knows is files in one local git repo. To avoid `.git/index.lock`
   corruption with many concurrent agents, **only the Electron main process
   commits**. Agents never call git — they write plain files. (Research:
   GitHub Desktop's commit-queue pattern; lazygit/git-retry backoff.)
2. **Single-writer-per-file.** Each agent writes only inside its own
   `agents/<id>/` directory. Cross-agent delivery happens by the **router**
   (main process) moving messages from a sender's `outbox/` into a recipient's
   `inbox/`. No file is ever written by two processes.
3. **God-mode autonomy, native HITL.** A privileged **god agent** (lives in
   Michael's room) adjudicates cross-agent traffic. Routine requests
   (clarifications, data asks, plan tweaks) it resolves itself and the system
   keeps running fully autonomously. **Critical** items (destructive ops, spend,
   scope changes, unresolvable conflicts) route to the god, who surfaces them to
   the human natively in his own Claude Code session — there is no separate
   approval queue. Tool-permission prompts are the HITL gate, and they're
   approvable remotely from a phone via `/remote-control`.
4. **Memory: markdown first.** Per-agent `memory.md` + shared blackboard, with a
   SQLite FTS index when keyword recall isn't enough. A heavyweight vector layer
   (Letta/Mem0/Zep) is *not* needed at 5–15 agents and is architecturally wrong
   here (they want to own the agent runtime; our runtime is the `claude` CLI).
   Optional future upgrade: **MemPalace over MCP** (validate its retrieval first —
   its public benchmarks are overstated per independent audit).
5. **Autonomous loop = `Stop` hook.** An agent that finishes drains its inbox via
   a `Stop` hook that returns `{"decision":"block","reason":…}` to keep it
   working, guarded by `stop_hook_active` to prevent infinite loops.

---

## 3. On-disk layout — the "hive"

Lives under `<harnessHome>/hive/`, a git repo committed only by the main process.

```
hive/
  PROTOCOL.md            # the agent-facing contract (how to remember + message)
  registry.json          # roster: every agent, role, capabilities, status, seat
  board.md               # shared blackboard / co-authored plans
  tasks.json             # task ledger (id, assignee, spec, status, result ref)
  log.jsonl              # append-only event feed (drives the UI activity stream)
  agents/<agentId>/
    identity.md          # who am I, my role, my capabilities  (read at start)
    memory.md            # my long-term memory  (I read at start, append as I learn)
    inbox/               # messages delivered TO me — <ts>-<msgid>.json
    inbox/.done/         # processed messages (kept for audit, not deleted)
    outbox/              # messages I want to SEND — router drains these
    cursor.json          # { lastProcessed: <msgid> }  — avoids reprocessing
```

Design rules that make this robust:
- **One JSON file per message**, written via temp-file + atomic `rename` — never
  a co-edited shared mailbox file (those conflict under git).
- **Append-only** `log.jsonl`; consumers track their own cursor.
- `board.md` is the one genuinely co-edited file — it goes through the god agent
  (single scribe) to avoid conflicts.

---

## 4. Message schema (FIPA-lite)

Borrow the one useful idea from FIPA-ACL/KQML — the **speech act** — and drop the
LISP syntax. Seven semantic fields:

```jsonc
{
  "id":            "2026-05-30T14-03-11-123Z-a1b2",  // unique, time-sortable
  "conversation":  "conv-7f3",                        // groups a thread
  "in_reply_to":   "<prev msgid> | null",
  "from":          "agent.researcher",
  "to":            "agent.coder | god | broadcast",
  "act":           "request | inform | propose | query | agree | refuse | done",
  "subject":       "short human-readable summary",
  "body":          "free text / markdown / structured payload",
  "hops":          3,            // ++ per reply; capped to kill ping-pong loops
  "requires_reply": true,        // only request/query/propose obligate a reply
  "needs_human":   false,        // router/god may flip this to escalate
  "created_at":    "ISO-8601"
}
```

Anti-livelock rules: only `request`/`query`/`propose` obligate a reply (pure
`inform`/`done` are terminal); every reply increments `hops`; past a hop cap the
god agent escalates instead of letting two agents loop forever; re-seeing a
processed `id` is a no-op (idempotent via cursor).

---

## 5. Control flow

```
agent B mid-task needs something from agent C
        │ writes  agents/B/outbox/<msg>.json   (act:request, to:C)
        ▼
┌─────────────────────── main process (the harness) ───────────────────────┐
│  Router watches every outbox/                                             │
│    → deliver to agents/C/inbox/   (to:"human" → routed to the god proxy;  │
│       the god surfaces critical calls natively in its own session)        │
│    → append to log.jsonl → git commit (single committer, retry+backoff)   │
└──────────────────────────────────────────────────────────────────────────┘
        │ delivered to C's inbox
        ▼
agent C finishes its current turn → Stop hook fires
        │ hook POSTs to the hive socket; main process checks C's inbox
        │ unread messages?  → reply {"decision":"block","reason": <messages>}
        ▼
agent C keeps working: reads the messages, acts, replies via its own outbox
```

The same hook socket drives the avatars: `PreToolUse`/`PostToolUse` payloads move
an agent to the right station (replacing today's `mockEvents.ts` / PTY-scraping).

---

## 6. The god agent (orchestrator)

A fixed, always-on agent seated at `desk-ceo` (Michael's room), `character:
michael`, flagged `isGod`. It is an ordinary `claude` process — the *intelligence*
— while the main process is the *mechanism* (git, sockets, routing). It owns:

- **Roster & routing** (`registry.json`): who exists, their capabilities, status.
- **Adjudication**: read each outbound request; resolve routine ones itself
  (answer clarifications, route to the right specialist with a self-contained
  task spec), escalate only critical ones. This is "god mode."
- **Blackboard scribe**: the single writer of `board.md`, so shared plans never
  conflict.
- **Task ledger** (`tasks.json`): assign, track, retry, checkpoint.

Its escalation policy (what counts as "critical") lives in its system prompt and
is the primary control surface — tune the prompt, not the code.

---

## 7. Departments & the board pipeline (fork direction)

Goal: assign a project to a hive and have it maintained like a company —
departments (Dev, QA, Marketing, Support, …) each running a pipeline of board
columns, with the human in the loop only through chat. Decided 2026-10-06.

### Principles

- **Keep the upstream cast.** The existing God and the hire templates
  (`docs/hires/manifests/`) are the roles; we extend them, we don't replace them.
- **Michael (God) is the single communication point** — Slack already feeds his
  message queue; Telegram joins it. He also does PO triage (dedup against open
  cards + the GSD roadmap, quick vs phase, ask the human when ambiguous). Split a
  dedicated PO out only if he gets overloaded.
- **Agents talk to the card, not to each other.** Handoff is by artifact
  (card → CONTEXT.md → PLAN.md → SUMMARY → PR), MetaGPT-style. The mailbox is
  for exceptions/escalations to Michael. Evidence: multi-agent failures are
  dominated by spec and coordination breakdowns (MAST), not by missing roles.
- **A column has an owner.** A card entering a column wakes its owner; the owner
  works, moves the card, sleeps. Michael owns no column — he routes, watches
  stalled cards, escalates, and sends a daily digest.
- **GSD is Dev-only.** Other departments reuse the *pattern* (stages, artifact
  handoff, human gates on external effects), not GSD itself. Departments connect
  at the edges: Support opens a bug card → Dev; a merged PR → Marketing card
  (release note).
- **The role owns the column and triggers the GSD command; GSD's own subagents
  do the work** (gsd-code-reviewer, gsd-security-auditor, …) — no duplicated agents.
- **The only human touchpoint in Dev is discuss** (plus `human_needed` from
  verify). Discuss runs as `discuss-phase --power`: questions land in
  `{NN}-QUESTIONS.json`, the harness relays them to chat, fills `answer`, then
  finalizes. Everything after discuss is autonomous.

### Agent lifecycle per card

Decided 2026-10-08. Column owners keep a live PTY (the avatar stays on the
floor) and get a clean context per card: entering a column queues `/clear` +
the card prompt on the owner's delivery queue, delivered only when idle (same
path as `/compact`). Continuity between stages lives in the artifacts — every
GSD command re-reads `STATE.md`/`CONTEXT.md`/`PLAN.md`, not the chat. A finished
owner with no next card just sits idle (an idle PTY burns no tokens).

**Michael is the exception:** no `/clear`, only compact — the router needs
continuity (what was triaged, who's stalled, the thread with the human);
durable facts go to his `memory.md`. One PTY per owner makes WIP 1 implicit;
parallelism means hiring a second instance (→ worktrees).

### Promotion to GSD

Decided 2026-10-08. Promoting keeps the card alive: it gets `phase = "999.x"`
and moves to Discuss, so it can walk the columns (the 5B "card disappears"
behavior is superseded). Michael promotes by moving the card's column in
`tasks.json`; main detects the change and runs the same deterministic
`promoteTaskToBacklog` as the kanban button — one code path, no tokens spent.
The same column-change event later wakes the column owner.

### PR merge

Decided 2026-10-08. Merge to `main` is reversible (squash → `git revert`), so
the target is auto-merge with a risk gate: Verify passed, CI green, no blocking
finding from Jim/Creed, and the diff touches no sensitive path (default:
migrations, auth, infra/terraform, CI, `.planning/config.json`; per-project list
in the department YAML). Anything else → `Aguardando você`.

It starts in **shadow mode**: the human merges every PR while Michael states
"would merge / would not" against the criteria. After **30 consecutive PRs**
with no disagreement, auto-merge turns on. Deploy is not covered here — it's an
external effect under the Phase 7 risk gates.

### Dev department — GSD steps mapped to the existing cast

| GSD step | Command | Owner |
| --- | --- | --- |
| GitHub issue/PR triage | `/gsd-inbox` | Michael |
| Feedback → backlog | `/gsd-capture --backlog` | Toby (feedback) |
| Exploration | `/gsd-explore`, `/gsd-spike`, `/gsd-sketch` | Ryan (prototype) |
| Discuss | `discuss-phase --power` | Ryan (prototype) |
| Phase research | plan-phase research step | Phyllis |
| UI contract | `/gsd-ui-phase` | Pam (designer) |
| Plan + plan-check | `/gsd-plan-phase` | Ryan (prototype) — new template only if volume demands |
| Execute (feature) | `/gsd-execute-phase`, `/gsd-quick` | Ryan (developer) |
| Execute (refactor/migration) | same | Stanley |
| Code review | `/gsd-code-review` (`--fix`) | Jim |
| Security | `/gsd-secure-phase` | Creed |
| Compliance (licenses, secrets) | gate before ship (no GSD command) | Toby (compliance) |
| Verify / UAT | `/gsd-verify-work` | Dwight |
| Test gaps | `/gsd-validate-phase`, `/gsd-add-tests` | Dwight |
| Debug | `/gsd-debug` | Dwight |
| Implemented-UI review | `/gsd-ui-review` | Pam (designer) |
| Docs | `/gsd-docs-update` | Pam (docs) |
| Ship / PR | `/gsd-ship` | Ryan (developer) |
| Milestone close | `/gsd-audit-milestone`, `/gsd-complete-milestone` | Michael |

Outside GSD: **Meredith** (weekly dependency updates → board card), **Angela**
(token budget per agent/card), **Kevin** (production data fixes, always behind a
human gate), **Oscar** (reports/metrics), **Kelly** (release notes, social),
**Erin** (front line for *external* customers — only once they exist; customer
messages must never reach Michael directly, since he holds routing authority).

### Example flow

```
"o botão Salvar está com a cor errada"  (Telegram/Slack → Michael)
  Michael: card in [Triagem] → dedup → trivial? → [Quick] (/gsd-quick, no discuss)
                                     → phase?   → promote to GSD backlog (5B) → [Discuss]
  Ryan (prototype): discuss --power → questions in chat → CONTEXT.md → [Plan] → PLAN.md
  Ryan (developer): [Execute] → Jim [Review] → Creed [Security] → Dwight [Verify]
  Ryan (developer): [Ship] → PR → Michael replies in the originating thread
```

### Department as config

A department is columns + owning roles + gates. Role entries reuse the hire
manifest shape plus two fields: `wake` and (Dev only) `gsd`.

```yaml
# departments/dev.yaml
columns: [Triagem, Aguardando você, Discuss, Plan, Execute, Review, Security, Verify, Ship, Done]
roles:
  - { hire: ryan-prototype,  wake: on-column Discuss, gsd: "discuss-phase --power" }
  - { hire: ryan-developer,  wake: on-column Execute, gsd: execute-phase, wip: 1 }
  - { hire: dwight-qa,       wake: on-column Verify,  gsd: verify-work }
gates: { Aguardando você: human }

# departments/marketing.yaml — no GSD
columns: [Temas sugeridos, Aguardando você, Redação, Revisão, Agendado, Publicado]
roles:
  - { hire: kelly-social, wake: cron daily }
gates: { Aguardando você: human, Agendado: human }
```

---

## 8. Phased plan

- **Phase 0 — Foundation** ✅: `hive.ts` on-disk layer + spawn injection
  (identity, protocol, env) + IPC to read hive state. Agents are hive-aware: they
  read their memory/inbox at task start and send via outbox; the router delivers;
  everything is committed and visible.
- **Phase 1 — Autonomy** ✅: `hooks.ts` UDS server + `cth-hook` shim (attached per
  agent via `--settings`) + `Stop`-loop so agents drain their inbox automatically
  and keep running (guarded by `stop_hook_active` + cursor); hook events stream to
  the renderer to drive avatars.
- **Phase 2 — God mode** ✅: the god agent auto-spawns into Michael's room
  (`desk-ceo` reserved) and, on a fresh spawn, is started with `/remote-control`
  (best-effort) plus an orientation prompt so it begins running the floor on its
  own. The router routes `to:"human"` traffic to the god (the human's proxy);
  there is no separate approval queue — human-in-the-loop is native to each
  agent's Claude Code session (permission prompts, approvable remotely from a
  phone). Idle agents are woken when they hold unread inbox messages.
- **Phase 3 — Semantic memory** ✅ (CLI integration): `memory.ts` wraps the
  **MemPalace CLI** (not MCP, by decision). The harness keeps one shared palace
  under `harnessHome`, points every agent's `MEMPALACE_PALACE_PATH` at it, mines
  each agent's `memory.md` into its own wing (mtime-gated), and agents recall via
  `mempalace search` / `wake-up`. Detect-and-degrade: a no-op when `mempalace`
  isn't installed (markdown memory still works). Default model `minilm` (light,
  for low-RAM Macs); `embeddinggemma` is the multilingual opt-in. A `MemoryPanel`
  lets the human search the same palace.
  - *Still open*: reflection/summarization to bound `memory.md`; needs a live
    `mempalace` install to validate retrieval end-to-end.
- **Phase 4 — Board pipeline** 🔲: `HiveTask` gains `column`, `department`,
  `phase` (linked GSD phase), `origin` (generalizes `slack`), `links`
  (duplicates/parent) and `lock`. Column-owner wake (extends the unread-inbox
  wake), stall timeout. Kanban → GSD backlog promote (5B) exists — rework it to
  keep the card (§7 "Promotion to GSD").
  - *Decided 2026-10-08*: serial — one PTY per owner means WIP 1; worktrees only
    when a second instance of a role is hired. Failure loop: Verify/Review fail →
    back to Execute with the report attached; after 2 retries → `Aguardando você`
    via Michael. **Per-card token budget with hard stop** pulled forward from
    Phase 7 (the rest of governance stays there).
- **Phase 5 — Dev department on GSD** 🔲: department YAML + `wake`/`gsd` fields on
  hire manifests; §7 role mapping wired; Michael's triage rules in his prompt;
  Dev columns mirror real GSD state (`roadmap analyze`, `phase-plan-index`,
  `verification status`, `WAITING.json`, STATE `## Needs Human`).
- **Phase 6 — Chat bridge** 🔲: Telegram next to Slack as Michael's inbox;
  `discuss --power` `QUESTIONS.json` ↔ chat (buttons, answers written back,
  finalize); `Aguardando você` items pushed to chat; done replies to the
  originating thread.
- **Phase 7 — Governance** 🔲: token/money budget per agent and per card with hard
  stop (Angela), audit log of mutations and approvals, risk-tiered gates
  (read free, reversible write auto, money/external/irreversible → human),
  daily digest from Michael.
- **Phase 8 — Non-dev departments** 🔲: Marketing (Kelly), data ops (Kevin, human
  gate), maintenance routines (Meredith); Erin once there are external customers.

---

## 9. Key risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `index.lock` corruption | Single committer (main process), retry+backoff, stale-lock cleanup |
| Infinite Stop-hook loop | Guard on `stop_hook_active`; `hops` cap; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` |
| Two agents ping-ponging | Only request/query/propose obligate replies; hop cap → god escalates |
| Reprocessing messages | Per-agent `cursor.json`; processed messages move to `inbox/.done/` |
| `memory.md` unbounded growth | Phase 3 reflection/summarization |
| Modifying the user's repo with hooks | Write hooks to `<cwd>/.claude/settings.local.json` (gitignored convention) |
| Authority hijack via chat (Project Vend: fake "vote" replaced the CEO) | Goals, budgets and roster change only from the human's authenticated sender id; customer text goes through Erin, never straight to Michael |
| CEO agent rubber-stamping spend | Money/external effects approved by the human, not by Michael |
| Token burn from polling/re-onboarding (Paperclip critique) | Event-driven wake per column; long cron only for routines; cheap model for triage; project summary read on wake |
| Every message becoming a GSD phase | Michael's triage routes trivial items to `/gsd-quick`/`/gsd-fast` |

---

## 10. References

- Anthropic — *Building a multi-agent research system* (lead/subagent, plan-to-memory).
- LangGraph supervisor (structured routing + handoff registry + checkpoints).
- FIPA-ACL / KQML (speech acts).
- Stanford *Generative Agents* (memory stream, reflection, 2D world).
- Claude Code hooks reference (`Stop`, `PreToolUse`, `UserPromptSubmit`; `stop_hook_active`).
- Claude Code Channels (Telegram plugin, permission relay) — https://code.claude.com/docs/en/channels
- OpenAI Symphony SPEC (tracker as control plane, per-state concurrency, stall detection) — https://github.com/openai/symphony/blob/main/SPEC.md
- MAST — why multi-agent LLM systems fail — https://www.alphaxiv.org/abs/2503.13657
- Anthropic Project Vend phase 2 (governance lessons) — https://www.anthropic.com/research/project-vend-2
- Paperclip (org chart, budgets, heartbeats, goal ancestry) — https://github.com/paperclipai/paperclip
