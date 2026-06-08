#!/usr/bin/env node
// agent-comms MCP server: typed tools backed by SQLite (node:sqlite).
// Stdio transport — Claude Code spawns it and talks JSON-RPC over stdin/stdout.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
    openDb, appendLog, recordFileChange, sendMessage,
    openIssue, transitionIssue, signoff,
    listInbox, markInboxRead, recentEvents, listIssues, getIssue, stateSummary,
    recordDecision, approveDecision, decisionsList, decisionsGet,
    AGENTS, VALID_AREAS, VALID_SEVERITY, VALID_OPS, VALID_VERDICTS, VALID_FILE_VERBS,
    VALID_DECISION_STATES, VALID_DECISION_VERDICTS
} from './db.js';
import { loadCards, scoreTask } from './router.js';

const CARDS_DIR = process.env.AGENT_COMMS_CARDS
    || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agent-comms', 'cards');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AGENT_COMMS_DB
    || resolve(__dirname, '..', 'agent-comms', 'state.sqlite');

const db = openDb(DB_PATH);

const server = new McpServer({
    name: 'agent-comms',
    version: '0.1.0'
});

const Agent = z.enum(AGENTS);
const Severity = z.enum(VALID_SEVERITY);
const Area = z.enum(VALID_AREAS);
const FileVerb = z.enum(VALID_FILE_VERBS);
const Verdict = z.enum(VALID_VERDICTS);
const NonOpenOp = z.enum(VALID_OPS.filter(o => o !== 'open'));
const DecisionStatus = z.enum(VALID_DECISION_STATES);
const DecisionVerdict = z.enum(VALID_DECISION_VERDICTS);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ok = (data) => {
    const payload = isPlainObject(data) ? data : { items: data };
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: payload
    };
};
const fail = (err) => ({
    content: [{ type: 'text', text: `error: ${err.message || err}` }],
    isError: true
});
const wrap = (fn) => async (args) => {
    try { return ok(fn(args)); } catch (e) { return fail(e); }
};

// ===== READ tools =====

server.registerTool('state_summary', {
    description: 'Quick onboarding snapshot for an agent: unread inbox count + preview, your open issues, and recent team activity. Call this at the start of every turn. Pass `since` (ISO ts, typically the `cursor` from a previous call) to receive only the delta — empty when nothing changed. The response always includes a `cursor` you can chain into the next call.',
    inputSchema: {
        agent: Agent,
        since: z.string().optional()
    }
}, wrap(({ agent, since }) => stateSummary(db, { agent, since })));

server.registerTool('inbox_list', {
    description: 'List messages addressed to <agent>. Filter by unread_only.',
    inputSchema: {
        agent: Agent,
        unread_only: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(100).optional().default(20)
    }
}, wrap(({ agent, unread_only, limit }) => listInbox(db, { agent, unread_only, limit })));

server.registerTool('inbox_mark_read', {
    description: 'Mark messages as read for <agent>. Pass the event_ids returned by inbox_list.',
    inputSchema: {
        agent: Agent,
        event_ids: z.array(z.string()).min(1)
    }
}, wrap(({ agent, event_ids }) => markInboxRead(db, { agent, event_ids })));

server.registerTool('events_recent', {
    description: 'Recent activity feed (newest first). Optional filters by since (ISO ts), kinds, and limit. Pass `severity_min` (critical/high/medium/low/informational) to keep only events whose payload severity sits at or above the threshold; events without a severity in the payload (e.g. kind=log) are excluded when this filter is active.',
    inputSchema: {
        since: z.string().optional(),
        kinds: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).optional().default(30),
        severity_min: Severity.optional()
    }
}, wrap((args) => recentEvents(db, args)));

server.registerTool('issues_list', {
    description: 'List issues with optional filters.',
    inputSchema: {
        area: Area.optional(),
        assigned_to: Agent.optional(),
        state: z.string().optional(),
        severity: Severity.optional(),
        limit: z.number().int().min(1).max(200).optional().default(50)
    }
}, wrap((args) => listIssues(db, args)));

server.registerTool('issues_get', {
    description: 'Get the full state + transition history of an issue by id.',
    inputSchema: { issue_id: z.string() }
}, wrap(({ issue_id }) => getIssue(db, { issue_id })));

server.registerTool('route_task', {
    description: 'Suggest which agent should own a task, using deterministic lexical scoring against capability cards. No model call. Returns {recommended_agent, score, runners_up, rationale}. Pass hints.area to bias toward an area, hints.files to bias by file path patterns (e.g. *.tsx -> frontend, *.tf -> devops, *.test.* -> qa).',
    inputSchema: {
        task: z.string().min(1),
        hints: z.object({
            area: Area.optional(),
            files: z.array(z.string()).optional()
        }).optional()
    }
}, wrap(({ task, hints }) => scoreTask(task, hints || {}, loadCards(CARDS_DIR))));

// ===== WRITE tools (all atomic via SQLite transactions where multi-step) =====

server.registerTool('log', {
    description: 'Append a one-line activity log entry. Use at end of turn for sign-off.',
    inputSchema: {
        agent: Agent,
        summary: z.string().min(1),
        refs: z.array(z.string()).optional()
    }
}, wrap((args) => appendLog(db, args)));

server.registerTool('record_file_change', {
    description: 'Record that you added/edited/deleted a source file. Emit ONE call per file touched.',
    inputSchema: {
        agent: Agent,
        path: z.string().min(1),
        verb: FileVerb,
        why: z.string().min(1)
    }
}, wrap((args) => recordFileChange(db, args)));

server.registerTool('send_message', {
    description: 'Send a direct message to one or more peer agents. Recipients see it via inbox_list / state_summary.',
    inputSchema: {
        from: Agent,
        to: z.array(Agent).min(1),
        re: z.string().optional(),
        body: z.string().min(1),
        refs: z.array(z.string()).optional()
    }
}, wrap((args) => sendMessage(db, args)));

server.registerTool('open_issue', {
    description: 'Open a new issue. Atomic: writes both the issue row and the issue-open event in one transaction. Returns the new ISS-id. depends_on (optional) is an array of existing ISS-ids that must reach state=completed before this issue can be resolved.',
    inputSchema: {
        raised_by: Agent,
        area: Area,
        title: z.string().min(1),
        body: z.string().optional(),
        severity: Severity.optional().default('low'),
        assigned_to: Agent.optional(),
        refs: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional()
    }
}, wrap((args) => openIssue(db, args)));

server.registerTool('transition_issue', {
    description: 'Atomically transition an issue (claim/update/resolve/reject/block/unblock). Enforces state-machine + ownership rules. op=resolve is blocked if dependencies are not yet completed, or — for area=qa/security — if no approved signoff event exists for this issue. To update dependencies pass fields.depends_on (array of ISS-ids, or null to clear).',
    inputSchema: {
        issue_id: z.string(),
        by: Agent,
        op: NonOpenOp,
        fields: z.record(z.string(), z.any()).optional(),
        note: z.string().optional()
    }
}, wrap((args) => transitionIssue(db, args)));

server.registerTool('signoff', {
    description: 'Record a phase-gate verdict (typically by review-architect). Does not change issue state — pair with transition_issue if needed.',
    inputSchema: {
        agent: Agent,
        issue_id: z.string(),
        verdict: Verdict,
        note: z.string().optional()
    }
}, wrap((args) => signoff(db, args)));

// ===== DECISION tools (structured ADRs) =====

server.registerTool('decision_record', {
    description: 'Record a new architecture decision (ADR) in status=proposed. Atomic: writes the decisions row and a decision event in one transaction. Pass `supersedes` (DEC-id or slug) to link a predecessor — the predecessor is flipped to status=superseded only when this proposal is later approved.',
    inputSchema: {
        raised_by: Agent,
        area: Area.optional(),
        title: z.string().min(1),
        context: z.string().min(1),
        decision: z.string().min(1),
        consequences: z.string().optional(),
        refs: z.array(z.string()).optional(),
        supersedes: z.string().optional()
    }
}, wrap((args) => recordDecision(db, args)));

server.registerTool('decision_approve', {
    description: 'Approve or reject a proposed decision. Only review-architect may call this. On approve, status -> accepted; if the decision has a supersedes target, that predecessor is flipped to superseded in the same transaction. On reject, status -> rejected.',
    inputSchema: {
        by: Agent,
        decision_id: z.string().min(1),
        verdict: DecisionVerdict,
        note: z.string().optional()
    }
}, wrap((args) => approveDecision(db, args)));

server.registerTool('decisions_list', {
    description: 'List decisions with optional filters (area, status, since, limit). Ordered by updated_at DESC.',
    inputSchema: {
        area: Area.optional(),
        status: DecisionStatus.optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50)
    }
}, wrap((args) => decisionsList(db, args)));

server.registerTool('decisions_get', {
    description: 'Get a decision (by DEC-id or slug) plus its history (record + approve/reject + supersede events).',
    inputSchema: { decision_id: z.string().min(1) }
}, wrap(({ decision_id }) => decisionsGet(db, { decision_id })));

// ===== boot =====

const transport = new StdioServerTransport();
await server.connect(transport);
// Don't log to stdout — it's the MCP transport. stderr is safe.
process.stderr.write(`[agent-comms-mcp] ready (db: ${DB_PATH})\n`);
