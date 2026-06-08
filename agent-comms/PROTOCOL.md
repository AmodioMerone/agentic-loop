# Inter-Agent Communication Protocol — v3.1

> v3.1 adds phase-gate push (auto-message on `awaiting_signoff`) on top of v3.
> v3 supersedes v1 (shared markdown) and v2 (per-agent JSONL).
> See [`../PARADIGM-EVOLUTION.md`](../PARADIGM-EVOLUTION.md) for the history.

## The model

All inter-agent state lives in **SQLite** (`agent-comms/state.sqlite`),
accessed through the **`agent-comms` MCP server** at
[`../mcp-server/`](../mcp-server/). Agents never read or write the database
file directly — they call **typed MCP tools** that wrap atomic SQL
operations.

Properties this gives you:
- **ACID transactions** — `open_issue` and `transition_issue` write event +
  state row in one transaction. No drift, no half-applied state.
- **Concurrency safety** — SQLite WAL mode + `BEGIN IMMEDIATE`; 50 parallel
  writes in the smoke test, zero conflicts.
- **Sparse reads** — `state_summary` returns only what you need to start
  your turn (unread count, your open issues, last 10 events).
- **Typed contracts** — every tool has a Zod-validated input schema.
- **Audit trail** — `events` table is append-only; transition history is
  queryable per issue.

## Tools you can call

(Definitive schemas in [`../mcp-server/server.js`](../mcp-server/server.js).)

### Reads
| Tool             | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `state_summary`  | One-call onboarding snapshot for an agent. **Call first every turn.**   |
| `inbox_list`     | Messages addressed to you, optionally unread-only.                      |
| `events_recent`  | Recent activity feed across the team.                                   |
| `issues_list`    | Filter by `area`, `assigned_to`, `state`, `severity`.                   |
| `issues_get`     | Full state + transition history of one issue.                           |

### Writes (atomic)
| Tool                 | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `log`                | Append a one-line activity entry. Use to sign off the turn.          |
| `record_file_change` | Record a source-file edit. One call per file touched.                |
| `send_message`       | Direct message to one or more agents.                                |
| `open_issue`         | Create issue (state row + open event in one txn). Returns ISS-id.    |
| `transition_issue`   | `claim` / `update` / `resolve` / `reject` / `block` / `unblock`.     |
| `inbox_mark_read`    | Mark messages you've processed.                                      |
| `signoff`            | Phase-gate verdict (typically by `review-architect`).                |

## Turn loop (every agent, every invocation)

1. **Onboard** — call `state_summary({ agent: "<YOUR-NAME>" })`. You get
   unread inbox count + preview, your open issues, recent activity.
2. **Drill in** if needed — `inbox_list({ unread_only: true })`,
   `issues_get({ issue_id })`, `events_recent`.
3. **Work** — actual file edits.
4. **Record** — for each file touched: `record_file_change`. For each
   peer you need to involve: `send_message` (async) OR call them via the
   `Agent` tool with `subagent_type=<peer>` (sync). When you spot a
   problem outside your domain: `open_issue` with the right `area` and
   `assigned_to`.
5. **Mark read** — `inbox_mark_read` for the messages you addressed.
6. **Sign off** — `log({ summary: "<one line>", refs: [...] })`.
7. **Return** — a ≤ 8-line summary to your caller.

## State machine for issues

```
submitted --(claim)--> working --(resolve)--> completed
                        |
                        +--(block)--> blocked --(unblock)--> working
                        +--(input_required via update)
                        +--(reject)--> rejected
                        +--(cancel via update)--> canceled
```

Ownership rule: only the current `assigned_to` may transition the issue.
**Exception**: `op=claim` is how you take ownership in the first place.
Attempting to bypass this returns an error from the MCP server.

## Vocabularies
- `area`: `backend` `frontend` `qa` `arch` `devops` `security` `docs`
- `severity`: `critical` `high` `medium` `low` `informational`
- `state`: `submitted` `working` `input_required` `blocked` `completed`
  `failed` `canceled`
- `file_change.verb`: `add` `edit` `delete`
- `signoff.verdict`: `approved` `changes_requested` `rejected`

## Identità degli agenti

`backend-senior-dev` `frontend-senior-dev` `qa-specialist`
`review-architect` `devops-engineer` `security-auditor` `tech-writer`

Capability cards: see `cards/*.json` (used for routing decisions).

## Hard rules

- **Never write to `state.sqlite` directly** — always go through MCP tools.
  Direct writes bypass ACID validation and break the audit trail.
- **Always pass your own `<agent>` name** in tool args — the server tags
  every write with the calling agent for attribution.
- **Don't loop** — if a peer calls you via `Agent` tool and you would
  call them back, file an issue instead and return.

## Phase gates (enforced server-side)

For issues whose `area` is `qa` or `security`, `transition_issue({ op: "resolve" })`
is **rejected** unless an approved `signoff` event already exists for the
same `issue_id`. This is enforced inside the SQL transaction — it cannot
be bypassed by skipping a hook or editing files.

Practical recipe: when you're about to mark such an issue completed,
first arrange a `signoff({ agent: "review-architect", issue_id, verdict: "approved" })`.

### Phase-gate push (v3.1)

`transition_issue` now accepts `fields.awaiting_signoff: true`. When the
issue moves to `input_required` with that flag set, the server emits a
`kind='message'` event in the same SQL transaction, addressed to the
competent signer:
- `area` ∈ `arch` / `qa` → `review-architect`
- `area` = `security` → `security-auditor`

The signer no longer has to poll: `state_summary` for `review-architect`
and `security-auditor` now includes a `pending_signoffs[]` array
(issues with `awaiting_signoff=true` and no approved signoff yet),
surfaced at every onboarding.

Idempotent: re-sending `awaiting_signoff: true` on the same issue while
it's already pending does **not** duplicate the auto-message — the server
de-dupes against the existing pending signoff for the same issue.

Producers (`backend-senior-dev`, `frontend-senior-dev`, `qa-specialist`,
and any agent driving a phase-gated issue) set the flag when handing
work off. Manual `send_message` to the signer is no longer needed.

### Delta-based onboarding (v3.1)

`state_summary({ agent, since? })` accepts an optional `since` parameter
(ISO-8601 timestamp). When set, the summary is filtered to **deltas only**:
events emitted after `since`, issues updated after `since`,
`pending_signoffs` raised after `since`, and the unread inbox count for
that window. The response always includes a `cursor` field — the
timestamp of the newest event in the summary, or `since` itself if
nothing newer exists.

**When to use it**:
- First turn of a session: call **without** `since` → full snapshot.
- Later turns in the same session: pass `since: <last_cursor>` → only the
  delta since your last onboarding.
- Typical payload drops from ~8 KB to under 1 KB.

**Limitation**: agents spawned via the `Agent` tool start fresh each
invocation and have no memory of a previous `cursor`. The pattern pays
off only when:
- The manager re-spawns the same agent and includes the prior `cursor`
  in the briefing.
- A persistent role (e.g. `feature-owner`) keeps `cursor` across the
  multiple turns of a single long-running task.

## Plan-approval convention

There is **no** separate "plan approval" MCP tool. For a non-trivial design
change (architectural refactor, breaking API, schema migration), use the
existing primitives:

1. The proposing agent calls
   `open_issue({ area: "arch", title: "Plan: <what>", body: "<the plan>" })`.
2. `review-architect` reviews and emits
   `signoff({ issue_id, verdict: "approved" | "changes_requested" | "rejected", note })`.
3. Only on `approved` does the proposing agent transition the issue to
   `working` (via `claim`) and begin implementation.

Architecture issues are not phase-gated by `area`, so a `resolve` is allowed
without a signoff — the convention is that the *implementation kick-off*
waits for the signoff, not the eventual closure.

## Dependencies between issues

`open_issue` accepts an optional `depends_on: [<ISS-id>, ...]` array.
`transition_issue({ op: "resolve" })` is **rejected** while any declared
dependency is not in state `completed`. The dependency list can be edited
later via `transition_issue({ op: "update", fields: { depends_on: [...] } })`,
including `null` to clear.

## What to do when the MCP server isn't available

If `agent-comms` MCP tools are not listed in your tool set:
- Tell the user the MCP server isn't connected and stop. Don't fall
  back to writing markdown files — that paradigm is deprecated.
- Setup is documented in [`../README.md`](../README.md). One-line check:
  the project's `.mcp.json` should point at `./mcp-server/server.js`.
