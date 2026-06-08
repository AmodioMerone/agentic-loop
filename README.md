# Multi-Agent Development Environment

A "manager + specialists" agent team for Claude Code. A single **manager**
session parses a request, delegates to **specialist sub-agents** via the
`Agent` tool, and reports back. The agents coordinate peer-to-peer through
shared state held in **SQLite**, served by the **`agent-comms` MCP server**.

This README documents the orchestration environment — the team, the loop,
and the plumbing. It is not about whatever product the team happens to build.


---

## Setup (quickstart)

Clone-to-run path. `.mcp.json` already ships in the repo root, so you do not
create any wiring by hand.

1. **Prerequisite:** Node ≥ 22.5.0 (the server uses built-in `node:sqlite`; no
   native deps to compile).

2. **Install the server's dependencies.** All deps are pure-JS, so either
   package manager works:

   ```
   cd mcp-server && pnpm install   # or: npm install
   ```

3. **Open the project in Claude Code.** `.mcp.json` is already present in the
   repo root, so Claude Code registers the `agent-comms` server automatically
   on start. Restart the session if it was already open.

4. **Verify it works.** In a session, the `mcp__agent-comms__*` tools should
   appear in the agents' tool set. For an end-to-end check, run:

   ```
   node mcp-server/smoke-test.js
   ```

5. **Details and overrides** live in [§6](#6-running-and-wiring): env overrides
   (`AGENT_COMMS_DB`, `AGENT_COMMS_CARDS`), the restart-to-reload-cards note, and
   the `optimization-engineer` registration gap in `db.js`.

> If the `mcp__agent-comms__*` tools do **not** appear, the server isn't
> connected — agents should report that and stop, not fall back to writing
> markdown (consistent with §6).

---

## 1. Overview

The environment has three layers:

1. **Manager session** (`CLAUDE.md`) — the entry point. It receives the
   user's request, splits it into work items, picks the right specialist for
   each, and spawns them. The manager **delegates, coordinates, and reports**;
   it never writes or edits production code, and never runs build/test/deploy.

2. **Specialist agents** (`.claude/agents/*.md`) — nine role-scoped agents,
   each a fresh sub-agent invoked through the `Agent` tool with
   `subagent_type=<name>`. They do the actual work: read code, edit files,
   run commands, and coordinate with each other.

3. **Communication layer** (`mcp-server/` + `agent-comms/`) — a Node MCP
   server backed by a single SQLite database (`agent-comms/state.sqlite`).
   All inter-agent state — messages, issues, events, signoffs, decisions —
   flows through typed MCP tools, never by reading or writing files.

The user talks only to the manager. Specialists never talk to the user; they
talk to the manager (who spawned them) and to each other (through the MCP
tools).

---

## 2. The agent team

Nine agents are defined. Each has a definition in `.claude/agents/<name>.md`
(model, allowed tools, expertise, collaborators, protocol, style) and a
machine-readable capability card in `agent-comms/cards/<name>.json` used for
deterministic routing. **All nine agents now have a capability card.**

| Agent                   | Model  | When to call                                                      |
| ----------------------- | ------ | ----------------------------------------------------------------- |
| `backend-senior-dev`    | opus   | Server-side code, REST/GraphQL/gRPC APIs, DB schema, migrations, jobs, query tuning |
| `frontend-senior-dev`   | sonnet | UI components, client state, accessibility, browser performance, design system |
| `qa-specialist`         | sonnet | Unit/integration/e2e tests, bug repro, edge cases, regression coverage |
| `review-architect`      | opus   | Design review, cross-cutting concerns, coupling/cohesion, ADR triggers, signoff authority |
| `devops-engineer`       | sonnet | CI/CD, Docker/K8s, IaC, secrets, observability, deploy and rollback |
| `security-auditor`      | opus   | Security review, threat modeling, OWASP/authn/authz, secrets, CVE triage, signoff authority |
| `tech-writer`           | opus   | README, API docs, ADRs, changelogs, runbooks, migration guides    |
| `feature-owner`         | opus   | Cross-area features (≥2 areas, ≥3 files, framed as feature/epic); coordinates, never codes |
| `optimization-engineer` | opus   | Profiling and perf/latency/throughput, memory, algorithmic complexity, query/cache tuning (added today) |

### What each agent does

- **`backend-senior-dev`** — Owns the `backend` area: APIs, data modeling,
  migrations, background jobs, idempotency, query performance. Pulls in
  `qa-specialist` for tests, `security-auditor` for sensitive endpoints,
  `frontend-senior-dev` on contract changes, `devops-engineer` for new env
  vars/migrations, `tech-writer` for public API changes. Writes code.

- **`frontend-senior-dev`** — Owns the `frontend` area: components, client
  state, a11y, CSS, browser perf. Coordinates with `backend-senior-dev` on
  API contracts, `qa-specialist` on e2e/visual flows, `security-auditor` on
  XSS/CSP/token storage. Writes code.

- **`qa-specialist`** — Owns the `qa` area: writes failing tests first to
  reproduce bugs, then black-box behavior tests. Claims its issue, reports a
  verdict via `transition_issue`, and reassigns to a dev when a fix is needed.
  Writes test code.

- **`review-architect`** — Read-only on code. Produces structured reviews
  (good / concerns / blockers), captures proposed changes as issues, and holds
  **signoff authority** for `arch` and `qa` work. Triggers ADRs by handing a
  draft to `tech-writer` or recording a decision.

- **`devops-engineer`** — Owns the `devops` area: pipelines, containers, IaC,
  secrets, observability. States a deploy plan early, flags breaking deploy
  ordering as an issue, and always documents a rollback path. Writes infra
  files; never commits plaintext secrets.

- **`security-auditor`** — Read-only on code (one-line trivial fixes aside).
  Audits for sinks, classifies findings by severity without inflation, files
  issues assigned to the right dev, and holds **signoff authority** for
  `security` work.

- **`tech-writer`** — Owns the `docs` area: README/ADR/changelog/runbook/
  migration guides. Confirms behavior with the relevant dev before writing —
  never invents. Writes docs.

- **`feature-owner`** — Cross-area coordinator. **Read-only on code.**
  Decomposes a feature into 3–8 sub-task issues (one area each), spawns the
  specialists (parallel where independent, ≤5 per turn), tracks the issue
  graph, and synthesizes a feature-level report. Does **not** sign off its own
  feature — that authority stays with `review-architect` and
  `security-auditor`. Never spawns a nested `feature-owner`.

- **`optimization-engineer`** — Performance specialist. Measures a baseline
  before changing anything, finds the real bottleneck with a profiler, changes
  one lever at a time, re-measures, and reports the before→after delta. Pulls
  in `qa-specialist` for a regression guard and `review-architect` when an
  optimization changes a boundary or contract. Writes code. *(Added today; its
  card declares the `performance` area — see the wiring note in §6.)*

---

## 3. The agentic loop

A user request flows end-to-end like this:

```
        user
          |
          v
   +---------------+   1. parse into work items
   |   manager     |   2. pick agent per item (CLAUDE.md table
   |  (CLAUDE.md)  |      or route_task scoring the cards)
   +-------+-------+
           | 3. spawn via Agent(subagent_type=...)
           |    parallel when independent (≤5/turn)
           |    sequential when B needs A's output
   +-------+----------------------------+
   |       |               |            |
   v       v               v            v
 backend  frontend       qa          ...specialists
   |       |               |            |
   |       +---- peer-to-peer via agent-comms MCP -----+
   |              (send_message, open_issue,           |
   |               transition_issue, record_file_change)
   |                                                   |
   |      phase gate: qa/security resolve needs an     |
   |      approved signoff from review-architect /     |
   |      security-auditor (enforced in SQL)           |
   |                                                   |
   +------> each agent returns a ≤8-line summary ------+
                          |
                          v
                   manager reports to the user
                   (what was done, by whom, files, open ISS-ids)
```

### Step by step

1. **Parse.** The manager breaks the request into work items and assigns an
   effort tier (see §4). If unsure who owns an item, it starts with
   `review-architect` for triage.

2. **Route.** Two routing paths exist:
   - **Manual** — the manager picks from the team table in `CLAUDE.md`.
   - **Deterministic** — `route_task` (backed by `router.js`) scores the task
     text against every capability card and recommends an agent. No model call
     (see §5).

3. **Spawn.** The manager calls the `Agent` tool with `subagent_type=<name>`,
   briefing each agent like a colleague who hasn't seen the conversation: goal,
   what's known, files in scope, expected output shape, size cap. Independent
   items go in **one message with multiple `Agent` calls** (parallel);
   dependent items run sequentially (B is briefed with A's result).

4. **Work + coordinate.** Each spawned agent runs its own turn loop (from
   `agent-comms/PROTOCOL.md`):
   - **Onboard** — `state_summary({ agent })` for unread inbox, open issues,
     recent activity. Later turns of a long-running role can pass
     `since: <cursor>` for a delta-only snapshot.
   - **Work** — edit files.
   - **Record** — one `record_file_change` per file touched.
   - **Coordinate** — `send_message` (async) or spawn a peer via `Agent`
     (sync); `open_issue` for problems outside its domain. Agents talk
     **directly**; the manager does not relay messages.
   - **Sign off** — `log` a one-line entry.
   - **Return** — a ≤8-line summary to the caller.

5. **Phase-gate.** Issues in area `qa` or `security` cannot be resolved until
   an approved `signoff` event exists. When a producer flips
   `fields.awaiting_signoff: true` on a transition to `input_required`, the
   server auto-messages the competent signer (`review-architect` for
   `arch`/`qa`, `security-auditor` for `security`) and surfaces it in that
   signer's `pending_signoffs[]` at onboarding. No manual relay needed.

6. **Report.** As each agent returns, the manager reads its summary, optionally
   checks `events_recent` / `issues_list({ state: "blocked" })`, and reports
   progress to the user — what was done, by whom, files touched, open follow-up
   issue ids.

### Where `feature-owner` fits

For a cross-area feature, the manager spawns `feature-owner` **instead of** a
direct specialist (criteria in §4). The feature-owner opens one issue per
sub-task (tagging every event `refs: ["epic:<slug>"]` so `metrics.js` can
compute end-to-end latency), spawns the specialists in parallel batches, tracks
the issue graph, and synthesizes a feature-level report. It does not write code
and does not sign off its own feature.

---

## 4. Coordination rules

### Effort tiers

| Tier          | Trigger                              | Routing                                              |
| ------------- | ------------------------------------ | ---------------------------------------------------- |
| trivial       | 1 file, 1 area, no tests             | 1 agent, a handful of internal tool calls            |
| standard      | 1 area, 2–5 files, tests             | 1–2 agents (dev + qa)                                |
| complex       | ≥2 areas                             | `feature-owner`                                      |
| architectural | schema-breaking, infra-critical      | `review-architect` first, then `feature-owner` if approved |

**Use `feature-owner`** when any holds: the task touches ≥2 areas, needs ≥3
source files, is framed as a feature/epic/user story, or its sub-deliverables
only make sense together. Otherwise route directly to a specialist.

### Spawn cap

**Hard rule: no more than 5 `Agent()` calls in parallel per turn.** Need more?
Sequence in batches of 5.

### Parallel-call discipline

Independent tool calls go in the **same batch** (one assistant message,
multiple tool invocations); sequence only when call B reads call A's output.
This applies to spawning agents, reading team status
(`events_recent` + `issues_list` together), and batched file reads.

```
Bad:   turn N:   Agent(backend)
       turn N+1: Agent(frontend)      # wasted a turn

Good:  turn N:   Agent(backend) + Agent(frontend)   # one message, two spawns
```

### The manager never edits production code

The manager delegates, coordinates, and reports. It does not read or edit
source files directly, does not run build/test/deploy, and does not skip
delegation "because it's faster." Two read-only coordinator roles share this
constraint: `feature-owner` and (on code) `review-architect` /
`security-auditor`.

---

## 5. The communication layer

All inter-agent state lives in **`agent-comms/state.sqlite`** (WAL mode),
accessed only through the **`agent-comms` MCP server** in `mcp-server/`.
Agents never touch the DB file directly — they call typed, Zod-validated MCP
tools that wrap atomic SQL transactions. This gives ACID writes (issue row +
event in one transaction), server-side enforcement of the issue state machine
and ownership rules, concurrency safety, an append-only audit trail, and sparse
onboarding.

### Server files (`mcp-server/`)

| File           | Role                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `server.js`    | The MCP server. Registers the typed tools over stdio, wires Zod input schemas, binds them to `db.js` handlers, and exposes `route_task` from `router.js`. |
| `db.js`        | SQLite schema + all state logic: `events` (append-only), `issues` (mutable), `inbox_reads`, `decisions`, counters. Holds the issue state machine, ownership checks, phase gates, dependency gates, and `state_summary`. |
| `router.js`    | Deterministic, zero-LLM task routing (see below).                                     |
| `metrics.js`   | Read-only baseline metrics: per-epic end-to-end latency (groups events by `epic:<slug>` refs), signoff lead time, and parallel-call ratio. |
| `retention.js` | Retention sweep: deletes only old `log`/`file_change` events and orphan `inbox_reads`; never touches `issue`/`signoff`/`decision`/`message`/`claim` rows. |
| `smoke-test.js`| End-to-end assertions over the tools (atomic writes, state machine, ownership, phase gates, dependency gates, 50 parallel writes). |

### MCP tools

Reads: `state_summary`, `inbox_list`, `events_recent`, `issues_list`,
`issues_get`, `route_task`, `decisions_list`, `decisions_get`.
Writes (atomic): `log`, `record_file_change`, `send_message`, `open_issue`,
`transition_issue`, `inbox_mark_read`, `signoff`, `decision_record`,
`decision_approve`.

Definitive schemas live in `mcp-server/server.js`; the protocol narrative is in
`agent-comms/PROTOCOL.md`.

### Capability cards (`agent-comms/cards/*.json`)

One card per agent: `name`, `version`, `summary`, `capabilities[]`, `areas[]`,
`routes_to[]`, `model_hint` (and `writes_code: false` for the coordinator
roles). These power deterministic routing.

### Deterministic routing (`router.js`)

`route_task({ task, hints })` recommends an agent **without any model call**.
It tokenizes the task text (lower-cased, split on non-alphanumerics, stop-words
dropped) and, for each card, builds a token bag from the card's
`capabilities`, `areas`, and `summary` (both the raw compound strings like
`secrets-management` and their tokenized sub-parts). The score is the count of
overlapping tokens, plus:

- `+50` when `hints.area` matches a card's `areas`,
- `+10` per file in `hints.files` whose path matches that agent's file-hint
  rules (e.g. `*.tsx` → frontend, `*.tf` → devops, `*.test.*` → qa,
  `server/`·`*.sql` → backend, `docs/`·non-README `*.md` → tech-writer).

It returns `{ recommended_agent, score, runners_up, rationale }`. Cost is
~O(cards × tokens) per call — cheap enough to run inline.

---

## 6. Running and wiring

### Requirements

- Node ≥ 22.5 (the server uses the built-in `node:sqlite`, so there are no
  native deps to compile). Runtime deps: `@modelcontextprotocol/sdk` and `zod`.

### Run the server

```
node mcp-server/server.js
```

It talks JSON-RPC over **stdio** (Claude Code spawns it; you do not run it by
hand in normal use). The DB defaults to `agent-comms/state.sqlite` and the
cards to `agent-comms/cards/` — override with `AGENT_COMMS_DB` and
`AGENT_COMMS_CARDS`.

### Wiring (`.mcp.json`)

Claude Code registers the server from the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-comms": {
      "command": "node",
      "args": ["--no-warnings", "./mcp-server/server.js"],
      "env": {}
    }
  }
}
```

When connected, the `mcp__agent-comms__*` tools appear automatically in each
agent's tool set. One-line health check: `.mcp.json` should point at
`./mcp-server/server.js`. If the tools are **not** listed, the server isn't
connected — agents should report that and stop, not fall back to writing
markdown (the pre-v3 paradigm is deprecated; see `PARADIGM-EVOLUTION.md`).

### Operational notes

- **Cards are cached in memory.** `router.js` reads and parses each card once,
  then caches it keyed by directory. **Restart the server to pick up a new or
  edited card** — adding `optimization-engineer.json` while the server is
  running won't change routing until the next start.

- **The `optimization-engineer` registration is incomplete server-side.** The
  agent definition and capability card exist (9 of each), but
  `mcp-server/db.js` still lists 8 agents in its `AGENTS` enum and its
  `VALID_AREAS` does not include `performance`. Until `db.js` is extended,
  MCP tool calls that pass `agent: "optimization-engineer"` or
  `area: "performance"` are rejected by Zod/`assertAgent`. `route_task` (which
  reads the cards directly) will still recommend it. Treat this as the next
  wiring step for that role.

- **Metrics depend on the `epic:<slug>` ref convention.** `feature-owner` tags
  every feature event with `refs: ["epic:<slug>"]`; a missed tag is a missed
  measurement in `metrics.js`.

- **Retention is safe by default.** `retention.js --dry-run` simulates inside a
  rolled-back transaction; a real sweep over the high-watermark needs
  `--confirm`. Audit-trail kinds are never deleted.
