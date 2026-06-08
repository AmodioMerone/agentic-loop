// SQLite-backed storage for the agent-comms MCP server.
// Uses node:sqlite (Node 22+ built-in) — no native deps, no compilation.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const VALID_KINDS = ['log', 'file_change', 'message', 'issue', 'signoff', 'claim', 'decision'];
const VALID_AREAS = ['backend', 'frontend', 'qa', 'arch', 'devops', 'security', 'docs', 'performance'];
const VALID_STATES = ['submitted', 'working', 'input_required', 'blocked', 'completed', 'failed', 'canceled'];
const VALID_SEVERITY = ['critical', 'high', 'medium', 'low', 'informational'];
const VALID_OPS = ['open', 'update', 'claim', 'resolve', 'reject', 'block', 'unblock'];
const VALID_VERDICTS = ['approved', 'changes_requested', 'rejected'];
const VALID_FILE_VERBS = ['add', 'edit', 'delete'];
const VALID_DECISION_STATES = ['proposed', 'accepted', 'superseded', 'rejected'];
const VALID_DECISION_VERDICTS = ['approve', 'reject'];

// Lookup used by stateSummary to surface decisions in the agent's home area.
const AGENT_TO_AREA = {
    'backend-senior-dev':  'backend',
    'frontend-senior-dev': 'frontend',
    'qa-specialist':       'qa',
    'review-architect':    'arch',
    'devops-engineer':     'devops',
    'security-auditor':    'security',
    'tech-writer':         'docs',
    'feature-owner':       'arch',
    'optimization-engineer': 'performance'
};

const AGENTS = [
    'backend-senior-dev','frontend-senior-dev','qa-specialist',
    'review-architect','devops-engineer','security-auditor','tech-writer',
    'feature-owner','optimization-engineer'
];

const SCHEMA_VERSION = 3;

export function openDb(path) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS events (
            id      TEXT PRIMARY KEY,
            ts      TEXT NOT NULL,
            agent   TEXT NOT NULL,
            kind    TEXT NOT NULL,
            payload TEXT NOT NULL,    -- JSON blob, kind-specific fields
            refs    TEXT               -- JSON array of strings
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_kind  ON events(kind);
        CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);

        CREATE TABLE IF NOT EXISTS issues (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            area        TEXT NOT NULL,
            raised_by   TEXT NOT NULL,
            assigned_to TEXT,
            severity    TEXT NOT NULL DEFAULT 'low',
            state       TEXT NOT NULL DEFAULT 'submitted',
            body        TEXT,
            refs        TEXT,
            depends_on  TEXT,         -- JSON array of ISS-ids; null if none
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            slug        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_issues_area     ON issues(area);
        CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to);
        CREATE INDEX IF NOT EXISTS idx_issues_state    ON issues(state);
        -- NOTE: idx_issues_slug is created by the v2 migration block below; on a
        -- pre-existing legacy DB the slug column doesn't exist yet at this point.

        CREATE TABLE IF NOT EXISTS inbox_reads (
            agent    TEXT NOT NULL,
            event_id TEXT NOT NULL,
            read_at  TEXT NOT NULL,
            PRIMARY KEY (agent, event_id)
        );

        CREATE TABLE IF NOT EXISTS issue_counters (
            day        TEXT PRIMARY KEY,
            last_seq   INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS decisions (
            id           TEXT PRIMARY KEY,
            slug         TEXT,
            title        TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'proposed',
            context      TEXT NOT NULL,
            decision     TEXT NOT NULL,
            consequences TEXT,
            area         TEXT,
            raised_by    TEXT NOT NULL,
            approved_by  TEXT,
            supersedes   TEXT,
            refs         TEXT,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
        CREATE INDEX IF NOT EXISTS idx_decisions_area   ON decisions(area);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_slug ON decisions(slug) WHERE slug IS NOT NULL;

        CREATE TABLE IF NOT EXISTS decision_counters (
            day        TEXT PRIMARY KEY,
            last_seq   INTEGER NOT NULL DEFAULT 0
        );
    `);

    // Migrations. `user_version` lives in the DB header; we bump it on every
    // breaking schema change. CREATE TABLE above always emits the *current*
    // shape, so existing DBs upgraded from a prior version need ALTER TABLE.
    const currentVersion = (db.prepare('PRAGMA user_version').get() || {}).user_version ?? 0;
    if (currentVersion < 1) {
        const issueCols = db.prepare('PRAGMA table_info(issues)').all().map(c => c.name);
        if (!issueCols.includes('depends_on')) {
            db.exec('ALTER TABLE issues ADD COLUMN depends_on TEXT');
        }
    }
    if (currentVersion < 2) {
        const issueCols = db.prepare('PRAGMA table_info(issues)').all().map(c => c.name);
        if (!issueCols.includes('slug')) {
            db.exec('ALTER TABLE issues ADD COLUMN slug TEXT');
        }
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_slug ON issues(slug) WHERE slug IS NOT NULL');
    }
    if (currentVersion < 3) {
        // decisions + decision_counters are emitted by the CREATE TABLE block above (idempotent).
        // Nothing to ALTER on legacy DBs — the IF NOT EXISTS guards cover all paths.
    }
    if (currentVersion < SCHEMA_VERSION) {
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    return db;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function tx(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function newEventId(agent) {
    const ts = nowIso().replace(/[-:]/g, '');
    const rand = randomBytes(2).toString('hex');
    return `evt_${ts}_${agent}_${rand}`;
}

function nextIssueId(db) {
    const day = nowIso().slice(0, 10).replace(/-/g, '');
    const row = db.prepare(
        'INSERT INTO issue_counters(day, last_seq) VALUES (?, 1) ' +
        'ON CONFLICT(day) DO UPDATE SET last_seq = last_seq + 1 ' +
        'RETURNING last_seq'
    ).get(day);
    const seq = String(row.last_seq).padStart(3, '0');
    return `ISS-${day}-${seq}`;
}

function nextDecisionId(db) {
    const day = nowIso().slice(0, 10).replace(/-/g, '');
    const row = db.prepare(
        'INSERT INTO decision_counters(day, last_seq) VALUES (?, 1) ' +
        'ON CONFLICT(day) DO UPDATE SET last_seq = last_seq + 1 ' +
        'RETURNING last_seq'
    ).get(day);
    const seq = String(row.last_seq).padStart(3, '0');
    return `DEC-${day}-${seq}`;
}

const ISS_ID_RE = /^ISS-\d{8}-\d{3}$/;
const DEC_ID_RE = /^DEC-\d{8}-\d{3}$/;
const SLUG_MAX = 24;

function slugifyTitle(title) {
    let s = String(title).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (s.length > SLUG_MAX) {
        const cut = s.slice(0, SLUG_MAX);
        // If the character right after the cut is a '-', the cut already lands on
        // a word boundary; otherwise we're slicing mid-word, so retreat to the
        // previous '-' (when one exists past the half-way mark).
        const cleanBoundary = s.charAt(SLUG_MAX) === '-';
        if (cleanBoundary) {
            s = cut;
        } else {
            const lastDash = cut.lastIndexOf('-');
            s = (lastDash >= Math.floor(SLUG_MAX / 2)) ? cut.slice(0, lastDash) : cut;
        }
    }
    return s.replace(/^-+|-+$/g, '');
}

// Allocate a slug unique within `table` (must have a `slug` column). Defaults
// to the issues table for back-compat with the original P0-2 callers.
function uniqueSlug(db, base, table = 'issues') {
    if (!base) return null;
    const check = db.prepare(`SELECT 1 FROM ${table} WHERE slug = ?`);
    if (!check.get(base)) return base;
    for (let n = 2; n <= 99; n++) {
        const suffix = `-${n}`;
        // Make room for the suffix while staying within SLUG_MAX.
        const trimmed = base.length + suffix.length > SLUG_MAX
            ? base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')
            : base;
        const candidate = `${trimmed}${suffix}`;
        if (!check.get(candidate)) return candidate;
    }
    throw new Error(`could not allocate a unique slug for base "${base}" within 99 attempts`);
}

// Accepts an ISS-id or a slug; returns the canonical ISS-id, or throws.
function resolveIssueId(db, ref) {
    if (typeof ref !== 'string' || !ref) {
        throw new Error(`issue reference must be a non-empty string; got: ${JSON.stringify(ref)}`);
    }
    if (ISS_ID_RE.test(ref)) {
        const row = db.prepare('SELECT id FROM issues WHERE id = ?').get(ref);
        if (!row) throw new Error(`issue ${ref} not found`);
        return row.id;
    }
    const row = db.prepare('SELECT id FROM issues WHERE slug = ?').get(ref);
    if (!row) throw new Error(`issue with slug "${ref}" not found`);
    return row.id;
}

// Accepts a DEC-id or a slug; returns the canonical DEC-id, or throws.
function resolveDecisionId(db, ref) {
    if (typeof ref !== 'string' || !ref) {
        throw new Error(`decision reference must be a non-empty string; got: ${JSON.stringify(ref)}`);
    }
    if (DEC_ID_RE.test(ref)) {
        const row = db.prepare('SELECT id FROM decisions WHERE id = ?').get(ref);
        if (!row) throw new Error(`decision ${ref} not found`);
        return row.id;
    }
    const row = db.prepare('SELECT id FROM decisions WHERE slug = ?').get(ref);
    if (!row) throw new Error(`decision with slug "${ref}" not found`);
    return row.id;
}

function assertOneOf(name, value, allowed) {
    if (!allowed.includes(value)) {
        throw new Error(`${name} must be one of ${JSON.stringify(allowed)}; got: ${value}`);
    }
}

function assertAgent(name) {
    if (!AGENTS.includes(name)) {
        throw new Error(`unknown agent "${name}"; valid: ${JSON.stringify(AGENTS)}`);
    }
}

// ---------- writes (single insert; atomic by SQLite) ----------

export function appendLog(db, { agent, summary, refs }) {
    assertAgent(agent);
    const id = newEventId(agent);
    const ts = nowIso();
    db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    ).run(id, ts, agent, 'log', JSON.stringify({ summary }), refs ? JSON.stringify(refs) : null);
    return { event_id: id, ts };
}

export function recordFileChange(db, { agent, path, verb, why }) {
    assertAgent(agent);
    assertOneOf('verb', verb, VALID_FILE_VERBS);
    const id = newEventId(agent);
    const ts = nowIso();
    db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    ).run(id, ts, agent, 'file_change', JSON.stringify({ path, verb, why }), JSON.stringify([path]));
    return { event_id: id, ts };
}

export function sendMessage(db, { from, to, re, body, refs }) {
    assertAgent(from);
    if (!Array.isArray(to) || to.length === 0) throw new Error('to must be a non-empty array');
    for (const t of to) assertAgent(t);
    const id = newEventId(from);
    const ts = nowIso();
    db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    ).run(id, ts, from, 'message',
          JSON.stringify({ to, re: re || null, body }),
          refs ? JSON.stringify(refs) : null);
    return { event_id: id, ts };
}

export function openIssue(db, { raised_by, area, title, body, severity = 'low', assigned_to, refs, depends_on }) {
    assertAgent(raised_by);
    assertOneOf('area', area, VALID_AREAS);
    assertOneOf('severity', severity, VALID_SEVERITY);
    if (assigned_to) assertAgent(assigned_to);
    if (depends_on !== undefined && depends_on !== null) {
        if (!Array.isArray(depends_on)) throw new Error('depends_on must be an array of issue ids');
        for (const d of depends_on) {
            if (typeof d !== 'string' || !d.startsWith('ISS-')) {
                throw new Error(`depends_on entries must be ISS-id strings; got: ${JSON.stringify(d)}`);
            }
        }
    }
    const insertEvent = db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    );
    const insertIssue = db.prepare(
        'INSERT INTO issues(id, title, area, raised_by, assigned_to, severity, state, body, refs, depends_on, created_at, updated_at, slug) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    return tx(db, () => {
        // Validate that any declared dependencies actually exist (within the txn).
        if (depends_on && depends_on.length) {
            const placeholders = depends_on.map(() => '?').join(',');
            const found = db.prepare(`SELECT id FROM issues WHERE id IN (${placeholders})`).all(...depends_on);
            const foundIds = new Set(found.map(r => r.id));
            const missing = depends_on.filter(d => !foundIds.has(d));
            if (missing.length) {
                throw new Error(`depends_on references unknown issue(s): ${missing.join(', ')}`);
            }
        }
        const ts = nowIso();
        const issue_id = nextIssueId(db);
        const event_id = newEventId(raised_by);
        const slug = uniqueSlug(db, slugifyTitle(title));
        insertIssue.run(
            issue_id, title, area, raised_by, assigned_to || null,
            severity, 'submitted', body || null,
            refs ? JSON.stringify(refs) : null,
            depends_on && depends_on.length ? JSON.stringify(depends_on) : null,
            ts, ts, slug
        );
        insertEvent.run(
            event_id, ts, raised_by, 'issue',
            JSON.stringify({
                issue_id, slug, op: 'open',
                // Surface severity at top level too so events_recent({severity_min}) can filter on it.
                severity,
                fields: { title, area, severity, state: 'submitted', assigned_to: assigned_to || null, depends_on: depends_on || null }
            }),
            refs ? JSON.stringify(refs) : null
        );
        return { issue_id, slug, event_id, ts };
    });
}

const TRANSITIONS = {
    submitted:      ['working', 'canceled', 'rejected'],
    working:        ['input_required', 'blocked', 'completed', 'failed', 'canceled'],
    input_required: ['working', 'canceled'],
    blocked:        ['working', 'canceled'],
    completed:      [],
    failed:         [],
    canceled:       []
};

const OP_TO_STATE = {
    claim:   'working',
    unblock: 'working',
    block:   'blocked',
    resolve: 'completed',
    reject:  'rejected',
    update:  null   // update keeps state unless fields.state provided
};

// Areas whose issues must carry an approved signoff before resolve.
const PHASE_GATED_AREAS = new Set(['qa', 'security']);

// When an owner flips fields.awaiting_signoff=true on a transition, we auto-emit
// a message to the area's reviewer(s). Keep this table small and obvious; areas
// not listed get no auto-message (silently skipped).
const SIGNERS_BY_AREA = {
    arch:     ['review-architect'],
    qa:       ['review-architect'],
    security: ['security-auditor'],
    performance: ['review-architect']
};

// Inverse of SIGNERS_BY_AREA: which areas each signer reviews. Used by
// stateSummary to surface pending_signoffs.
const AREAS_BY_SIGNER = {
    'review-architect': ['arch', 'qa', 'performance'],
    'security-auditor': ['security']
};

export function transitionIssue(db, { issue_id, by, op, fields, note }) {
    assertAgent(by);
    assertOneOf('op', op, VALID_OPS.filter(o => o !== 'open'));
    const insertEvent = db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    );
    return tx(db, () => {
        // Accept either an ISS-id or a slug; canonicalize to the row's id for the rest of the txn.
        issue_id = resolveIssueId(db, issue_id);
        const cur = db.prepare('SELECT * FROM issues WHERE id = ?').get(issue_id);
        if (!cur) throw new Error(`issue ${issue_id} not found`);

        let nextState = OP_TO_STATE[op];
        if (op === 'update' && fields && fields.state) nextState = fields.state;
        if (nextState && nextState !== cur.state) {
            const allowed = TRANSITIONS[cur.state] || [];
            if (!allowed.includes(nextState)) {
                throw new Error(`cannot transition ${cur.state} -> ${nextState}`);
            }
        }
        // Soft-ownership: only assigned_to (or raised_by if unassigned) may mutate.
        // Exception: 'claim' is the way to take ownership.
        if (op !== 'claim') {
            const owner = cur.assigned_to || cur.raised_by;
            if (by !== owner) {
                throw new Error(`agent ${by} is not the current owner of ${issue_id} (owner: ${owner}). Use op=claim first.`);
            }
        }

        // Validate depends_on if being changed.
        let nextDependsOnSerialized = cur.depends_on;
        if (fields && fields.depends_on !== undefined) {
            if (fields.depends_on === null) {
                nextDependsOnSerialized = null;
            } else {
                if (!Array.isArray(fields.depends_on)) {
                    throw new Error('fields.depends_on must be an array of issue ids');
                }
                for (const d of fields.depends_on) {
                    if (typeof d !== 'string' || !d.startsWith('ISS-')) {
                        throw new Error(`depends_on entries must be ISS-id strings; got: ${JSON.stringify(d)}`);
                    }
                }
                if (fields.depends_on.length) {
                    const placeholders = fields.depends_on.map(() => '?').join(',');
                    const found = db.prepare(`SELECT id FROM issues WHERE id IN (${placeholders})`).all(...fields.depends_on);
                    const foundIds = new Set(found.map(r => r.id));
                    const missing = fields.depends_on.filter(d => !foundIds.has(d));
                    if (missing.length) {
                        throw new Error(`depends_on references unknown issue(s): ${missing.join(', ')}`);
                    }
                }
                nextDependsOnSerialized = fields.depends_on.length ? JSON.stringify(fields.depends_on) : null;
            }
        }

        // Resolve-time gates (run only when this op completes the issue).
        if (op === 'resolve') {
            // 1. Dependencies must be completed.
            const depsRaw = nextDependsOnSerialized;
            if (depsRaw) {
                const deps = JSON.parse(depsRaw);
                if (Array.isArray(deps) && deps.length) {
                    const placeholders = deps.map(() => '?').join(',');
                    const depRows = db.prepare(
                        `SELECT id, state FROM issues WHERE id IN (${placeholders})`
                    ).all(...deps);
                    const foundIds = new Set(depRows.map(r => r.id));
                    const missing = deps.filter(d => !foundIds.has(d));
                    if (missing.length) {
                        throw new Error(`cannot resolve: depends_on references unknown issue(s): ${missing.join(', ')}`);
                    }
                    const blocking = depRows.filter(r => r.state !== 'completed');
                    if (blocking.length) {
                        const detail = blocking.map(b => `${b.id}(${b.state})`).join(', ');
                        throw new Error(`cannot resolve: dependencies not completed: ${detail}`);
                    }
                }
            }
            // 2. Phase-gate: qa / security need an approved signoff in events.
            const gateArea = fields?.area ?? cur.area;
            if (PHASE_GATED_AREAS.has(gateArea)) {
                const sig = db.prepare(
                    `SELECT id FROM events
                      WHERE kind = 'signoff'
                        AND json_extract(payload, '$.issue_id') = ?
                        AND json_extract(payload, '$.verdict') = 'approved'
                      LIMIT 1`
                ).get(issue_id);
                if (!sig) {
                    throw new Error(`area '${gateArea}' requires an approved signoff before resolve; current: none`);
                }
            }
        }

        // Compute the new row
        const merged = {
            title:       fields?.title       ?? cur.title,
            area:        fields?.area        ?? cur.area,
            severity:    fields?.severity    ?? cur.severity,
            assigned_to: (op === 'claim' ? by : (fields?.assigned_to ?? cur.assigned_to)),
            body:        fields?.body        ?? cur.body,
            refs:        fields?.refs        ? JSON.stringify(fields.refs) : cur.refs,
            depends_on:  nextDependsOnSerialized,
            state:       nextState           ?? cur.state,
        };
        if (merged.area)     assertOneOf('area', merged.area, VALID_AREAS);
        if (merged.severity) assertOneOf('severity', merged.severity, VALID_SEVERITY);
        if (merged.assigned_to) assertAgent(merged.assigned_to);

        const ts = nowIso();
        db.prepare(
            'UPDATE issues SET title=?, area=?, severity=?, assigned_to=?, body=?, refs=?, depends_on=?, state=?, updated_at=? WHERE id=?'
        ).run(merged.title, merged.area, merged.severity, merged.assigned_to,
              merged.body, merged.refs, merged.depends_on, merged.state, ts, issue_id);

        const event_id = newEventId(by);
        insertEvent.run(
            event_id, ts, by, 'issue',
            JSON.stringify({ issue_id, op, fields: fields || null, note: note || null, new_state: merged.state }),
            null
        );

        // Phase-gate push: when the owner declares the issue ready for review,
        // auto-emit a message to the area's signer(s). Idempotent: if we've
        // already pushed for this issue in the last 24h, skip the second one.
        let auto_message_event_id = null;
        if (fields && fields.awaiting_signoff === true) {
            const signers = SIGNERS_BY_AREA[merged.area];
            if (signers && signers.length) {
                const since = new Date(Date.parse(ts) - 24 * 60 * 60 * 1000)
                    .toISOString().replace(/\.\d{3}Z$/, 'Z');
                const dup = db.prepare(
                    `SELECT id FROM events
                      WHERE kind = 'message'
                        AND ts >= ?
                        AND json_extract(payload, '$.re') = ?
                        AND EXISTS (
                            SELECT 1 FROM json_each(refs) j WHERE j.value = ?
                        )
                      LIMIT 1`
                ).get(since, issue_id, issue_id);
                if (!dup) {
                    const msg_id = newEventId(by);
                    insertEvent.run(
                        msg_id, ts, by, 'message',
                        JSON.stringify({
                            to: signers,
                            re: issue_id,
                            body: `Issue ${issue_id} ('${merged.title}') is ready for signoff.`
                        }),
                        JSON.stringify([issue_id])
                    );
                    auto_message_event_id = msg_id;
                }
            }
        }

        return { event_id, ts, new_state: merged.state, assigned_to: merged.assigned_to, auto_message_event_id };
    });
}

export function signoff(db, { agent, issue_id, verdict, note }) {
    assertAgent(agent);
    assertOneOf('verdict', verdict, VALID_VERDICTS);
    const cur = db.prepare('SELECT id FROM issues WHERE id = ?').get(issue_id);
    if (!cur) throw new Error(`issue ${issue_id} not found`);
    const id = newEventId(agent);
    const ts = nowIso();
    db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    ).run(id, ts, agent, 'signoff', JSON.stringify({ issue_id, verdict, note: note || null }), null);
    return { event_id: id, ts };
}

// ---------- decisions (ADRs) ----------

// Record a new decision in 'proposed' state. Atomic: writes the decisions row
// and a 'decision' event in a single transaction. If `supersedes` is passed it
// must reference an existing decision; we DO NOT flip its status here — that
// happens when this proposal is approved (via approveDecision).
export function recordDecision(db, { raised_by, area, title, context, decision, consequences, refs, supersedes }) {
    assertAgent(raised_by);
    if (area !== undefined && area !== null) assertOneOf('area', area, VALID_AREAS);
    if (!title || typeof title !== 'string')   throw new Error('title is required');
    if (!context || typeof context !== 'string') throw new Error('context is required');
    if (!decision || typeof decision !== 'string') throw new Error('decision is required');
    const insertEvent = db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    );
    const insertDecision = db.prepare(
        'INSERT INTO decisions(id, slug, title, status, context, decision, consequences, area, raised_by, approved_by, supersedes, refs, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    return tx(db, () => {
        let supersedesId = null;
        if (supersedes !== undefined && supersedes !== null && supersedes !== '') {
            supersedesId = resolveDecisionId(db, supersedes);
        }
        const ts = nowIso();
        const decision_id = nextDecisionId(db);
        const slug = uniqueSlug(db, slugifyTitle(title), 'decisions');
        insertDecision.run(
            decision_id, slug, title, 'proposed',
            context, decision, consequences || null,
            area || null, raised_by, null, supersedesId,
            refs ? JSON.stringify(refs) : null,
            ts, ts
        );
        // Augment refs with the new DEC-id so events_recent / inbox queries can
        // surface decision lineage by ref filter.
        const allRefs = Array.isArray(refs) ? [...refs] : [];
        if (!allRefs.includes(decision_id)) allRefs.push(decision_id);
        const event_id = newEventId(raised_by);
        insertEvent.run(
            event_id, ts, raised_by, 'decision',
            JSON.stringify({
                op: 'record', decision_id, slug, title,
                area: area || null, status: 'proposed',
                supersedes: supersedesId
            }),
            JSON.stringify(allRefs)
        );
        return { decision_id, slug, event_id, ts };
    });
}

// Approve or reject a proposed decision. Only review-architect may do this.
// Atomic: updates decisions row(s) + emits the decision event in one txn.
// On approve+supersedes, also flips the predecessor to 'superseded'.
export function approveDecision(db, { by, decision_id, verdict, note }) {
    assertAgent(by);
    assertOneOf('verdict', verdict, VALID_DECISION_VERDICTS);
    if (by !== 'review-architect') {
        throw new Error(`only review-architect may approve/reject decisions; got: ${by}`);
    }
    const insertEvent = db.prepare(
        'INSERT INTO events(id, ts, agent, kind, payload, refs) VALUES (?,?,?,?,?,?)'
    );
    return tx(db, () => {
        const canonical = resolveDecisionId(db, decision_id);
        const cur = db.prepare('SELECT * FROM decisions WHERE id = ?').get(canonical);
        if (!cur) throw new Error(`decision ${canonical} not found`);
        if (cur.status !== 'proposed') {
            throw new Error(`decision ${canonical} is already finalized (status=${cur.status})`);
        }
        const nextStatus = verdict === 'approve' ? 'accepted' : 'rejected';
        const ts = nowIso();
        db.prepare(
            'UPDATE decisions SET status=?, approved_by=?, updated_at=? WHERE id=?'
        ).run(nextStatus, by, ts, canonical);

        let superseded_id = null;
        if (verdict === 'approve' && cur.supersedes) {
            const prev = db.prepare('SELECT id, status FROM decisions WHERE id = ?').get(cur.supersedes);
            if (prev) {
                // Only flip predecessors that are currently accepted/proposed; if it's
                // already superseded/rejected we leave it alone to avoid clobbering history.
                if (prev.status === 'accepted' || prev.status === 'proposed') {
                    db.prepare('UPDATE decisions SET status=?, updated_at=? WHERE id=?')
                        .run('superseded', ts, prev.id);
                    superseded_id = prev.id;
                }
            }
        }

        const event_id = newEventId(by);
        const refsArr = [canonical];
        if (superseded_id) refsArr.push(superseded_id);
        insertEvent.run(
            event_id, ts, by, 'decision',
            JSON.stringify({
                op: verdict, decision_id: canonical,
                verdict, note: note || null,
                new_status: nextStatus,
                superseded_id
            }),
            JSON.stringify(refsArr)
        );
        return { decision_id: canonical, status: nextStatus, event_id, ts, superseded_id };
    });
}

// ---------- reads ----------

function parseEventRow(r) {
    return {
        id: r.id, ts: r.ts, agent: r.agent, kind: r.kind,
        payload: JSON.parse(r.payload),
        refs: r.refs ? JSON.parse(r.refs) : null
    };
}

function parseIssueRow(r) {
    return {
        ...r,
        refs: r.refs ? JSON.parse(r.refs) : null,
        depends_on: r.depends_on ? JSON.parse(r.depends_on) : null
    };
}

export function listInbox(db, { agent, unread_only = false, limit = 20 }) {
    assertAgent(agent);
    // Find message events whose payload.to contains <agent>. node:sqlite supports JSON via json_extract.
    let rows = db.prepare(
        `SELECT e.* FROM events e
         WHERE e.kind = 'message'
           AND EXISTS (
               SELECT 1 FROM json_each(json_extract(e.payload, '$.to')) AS j
                WHERE j.value = ?
           )
         ORDER BY e.ts DESC
         LIMIT ?`
    ).all(agent, limit * 4); // overfetch then filter by unread

    if (unread_only) {
        const readSet = new Set(
            db.prepare('SELECT event_id FROM inbox_reads WHERE agent = ?')
              .all(agent).map(r => r.event_id)
        );
        rows = rows.filter(r => !readSet.has(r.id));
    }
    return rows.slice(0, limit).map(parseEventRow);
}

export function markInboxRead(db, { agent, event_ids }) {
    assertAgent(agent);
    if (!Array.isArray(event_ids) || event_ids.length === 0) return { marked: 0 };
    const stmt = db.prepare('INSERT OR IGNORE INTO inbox_reads(agent, event_id, read_at) VALUES (?,?,?)');
    const ts = nowIso();
    let n = 0;
    tx(db, () => {
        for (const eid of event_ids) {
            const r = stmt.run(agent, eid, ts);
            if (r.changes) n++;
        }
    });
    return { marked: n };
}

// Lower index = higher severity. When `severity_min` is given we accept any
// event whose payload severity sits at or above that level (i.e. has a rank
// <= the threshold's rank). Events without a `severity` field in their
// payload (e.g. kind=log) are excluded from the filtered result.
const SEVERITY_RANK = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    informational: 4
};

export function recentEvents(db, { since, limit = 30, kinds, severity_min } = {}) {
    let sql = 'SELECT * FROM events';
    const args = [];
    const cond = [];
    if (since) { cond.push('ts >= ?'); args.push(since); }
    if (kinds && kinds.length) {
        cond.push(`kind IN (${kinds.map(()=>'?').join(',')})`);
        args.push(...kinds);
    }
    if (severity_min) {
        assertOneOf('severity_min', severity_min, VALID_SEVERITY);
        const threshold = SEVERITY_RANK[severity_min];
        // Build a JSON-extracted severity expression and only keep rows whose
        // mapped rank is <= threshold. We use a CASE here because SQLite has
        // no direct enum-rank lookup and inlining keeps the query portable.
        const sevExpr = `json_extract(payload, '$.severity')`;
        cond.push(`(${sevExpr}) IS NOT NULL AND CASE ${sevExpr} ` +
            `WHEN 'critical' THEN 0 ` +
            `WHEN 'high' THEN 1 ` +
            `WHEN 'medium' THEN 2 ` +
            `WHEN 'low' THEN 3 ` +
            `WHEN 'informational' THEN 4 ` +
            `ELSE 99 END <= ?`);
        args.push(threshold);
    }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY ts DESC LIMIT ?';
    args.push(limit);
    return db.prepare(sql).all(...args).map(parseEventRow);
}

export function listIssues(db, { area, assigned_to, state, severity, limit = 50 } = {}) {
    let sql = 'SELECT * FROM issues';
    const args = [];
    const cond = [];
    if (area)        { cond.push('area = ?'); args.push(area); }
    if (assigned_to) { cond.push('assigned_to = ?'); args.push(assigned_to); }
    if (state)       { cond.push('state = ?'); args.push(state); }
    if (severity)    { cond.push('severity = ?'); args.push(severity); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    args.push(limit);
    return db.prepare(sql).all(...args).map(parseIssueRow);
}

function parseDecisionRow(r) {
    return {
        ...r,
        refs: r.refs ? JSON.parse(r.refs) : null
    };
}

export function decisionsList(db, { area, status, since, limit = 50 } = {}) {
    if (status) assertOneOf('status', status, VALID_DECISION_STATES);
    if (area)   assertOneOf('area', area, VALID_AREAS);
    const cap = Math.min(Math.max(limit | 0 || 50, 1), 200);
    let sql = 'SELECT * FROM decisions';
    const args = [];
    const cond = [];
    if (area)   { cond.push('area = ?');         args.push(area); }
    if (status) { cond.push('status = ?');       args.push(status); }
    if (since)  { cond.push('updated_at > ?');   args.push(since); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    args.push(cap);
    return db.prepare(sql).all(...args).map(parseDecisionRow);
}

export function decisionsGet(db, { decision_id }) {
    let canonical;
    try { canonical = resolveDecisionId(db, decision_id); }
    catch { return null; }
    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(canonical);
    if (!row) return null;
    // History: every decision event whose refs JSON array contains this id.
    const history = db.prepare(
        `SELECT id, ts, agent, kind,
                json_extract(payload, '$.op')           AS op,
                json_extract(payload, '$.verdict')      AS verdict,
                json_extract(payload, '$.new_status')   AS new_status,
                json_extract(payload, '$.superseded_id') AS superseded_id,
                json_extract(payload, '$.note')         AS note
           FROM events
          WHERE kind = 'decision'
            AND EXISTS (SELECT 1 FROM json_each(refs) j WHERE j.value = ?)
          ORDER BY ts ASC`
    ).all(canonical);
    return { ...parseDecisionRow(row), history };
}

export function getIssue(db, { issue_id }) {
    // Accept either an ISS-id or a slug. Return null on miss to preserve prior contract.
    let canonical;
    try { canonical = resolveIssueId(db, issue_id); }
    catch { return null; }
    const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(canonical);
    if (!row) return null;
    issue_id = canonical;
    // Merge issue transitions and signoffs into one chronological timeline.
    const history = db.prepare(
        `SELECT id, ts, agent, kind,
                json_extract(payload, '$.op')        AS op,
                json_extract(payload, '$.new_state') AS new_state,
                json_extract(payload, '$.verdict')   AS verdict,
                json_extract(payload, '$.note')      AS note
           FROM events
          WHERE (kind = 'issue' OR kind = 'signoff')
            AND json_extract(payload, '$.issue_id') = ?
          ORDER BY ts ASC`
    ).all(issue_id);
    return { ...parseIssueRow(row), history };
}

export function stateSummary(db, { agent, since }) {
    assertAgent(agent);
    // When `since` is provided we operate as a delta: only include events,
    // issues, and signoff candidates that changed strictly after that ts.
    // The returned `cursor` lets the caller idempotently chain the next call.
    const hasSince = typeof since === 'string' && since.length > 0;
    const readSet = new Set(
        db.prepare('SELECT event_id FROM inbox_reads WHERE agent = ?').all(agent).map(r => r.event_id)
    );
    const inboxStmt = hasSince
        ? db.prepare(
            `SELECT * FROM events e
              WHERE kind = 'message'
                AND ts > ?
                AND EXISTS (SELECT 1 FROM json_each(json_extract(e.payload, '$.to')) j WHERE j.value = ?)
              ORDER BY ts DESC LIMIT 50`)
        : db.prepare(
            `SELECT * FROM events e
              WHERE kind = 'message'
                AND EXISTS (SELECT 1 FROM json_each(json_extract(e.payload, '$.to')) j WHERE j.value = ?)
              ORDER BY ts DESC LIMIT 50`);
    const inbox = (hasSince ? inboxStmt.all(since, agent) : inboxStmt.all(agent)).map(parseEventRow);
    const unread = inbox.filter(m => !readSet.has(m.id));
    const myOpenStmt = hasSince
        ? db.prepare(
            `SELECT id, title, state, severity, area, updated_at FROM issues
              WHERE assigned_to = ? AND state NOT IN ('completed','failed','canceled')
                AND updated_at > ?
              ORDER BY updated_at DESC`)
        : db.prepare(
            `SELECT id, title, state, severity, area, updated_at FROM issues
              WHERE assigned_to = ? AND state NOT IN ('completed','failed','canceled')
              ORDER BY updated_at DESC`);
    const myOpen = hasSince ? myOpenStmt.all(agent, since) : myOpenStmt.all(agent);
    const recent = hasSince
        ? recentEvents(db, { since, limit: 10 }).filter(e => e.ts > since)
        : recentEvents(db, { limit: 10 });
    const out = {
        agent,
        unread_count: unread.length,
        unread_preview: unread.slice(0, 5).map(m => ({
            id: m.id, ts: m.ts, from: m.agent, re: m.payload.re, body_snippet: (m.payload.body||'').slice(0, 120)
        })),
        my_open_issues: myOpen,
        recent_activity: recent.map(e => ({ ts: e.ts, agent: e.agent, kind: e.kind, summary: e.payload.summary || e.payload.path || e.payload.issue_id || null }))
    };

    // Signer-only: surface issues waiting for this agent's signoff. We pull
    // input_required issues in the agent's review areas, then drop any that
    // have a fresher signoff event (i.e. already reviewed since last update).
    // When `since` is provided, omit issues whose owner state hasn't moved
    // after `since` — they are stale from the caller's perspective.
    const ownAreas = AREAS_BY_SIGNER[agent];
    if (ownAreas && ownAreas.length) {
        const placeholders = ownAreas.map(() => '?').join(',');
        const candStmt = hasSince
            ? db.prepare(
                `SELECT id, slug, title, area, severity, raised_by, assigned_to, updated_at
                   FROM issues
                  WHERE state = 'input_required'
                    AND area IN (${placeholders})
                    AND updated_at > ?
                  ORDER BY updated_at ASC
                  LIMIT 20`)
            : db.prepare(
                `SELECT id, slug, title, area, severity, raised_by, assigned_to, updated_at
                   FROM issues
                  WHERE state = 'input_required'
                    AND area IN (${placeholders})
                  ORDER BY updated_at ASC
                  LIMIT 20`);
        const candidates = hasSince ? candStmt.all(...ownAreas, since) : candStmt.all(...ownAreas);
        const sigStmt = db.prepare(
            `SELECT 1 FROM events
              WHERE kind = 'signoff'
                AND json_extract(payload, '$.issue_id') = ?
                AND ts > ?
              LIMIT 1`
        );
        out.pending_signoffs = candidates
            .filter(r => !sigStmt.get(r.id, r.updated_at))
            .map(r => ({
                issue_id: r.id, slug: r.slug, title: r.title, area: r.area,
                severity: r.severity, raised_by: r.raised_by,
                assigned_to: r.assigned_to, since: r.updated_at
            }));
    }

    // Signer-only: implicit subscription to recent activity across their
    // review areas, even on issues they don't own. This complements
    // pending_signoffs (which only surfaces input_required) by showing
    // anything the signer might want to keep an eye on (last 24h, by area).
    if (ownAreas && ownAreas.length) {
        const cutoffMs = Date.parse(nowIso()) - 24 * 60 * 60 * 1000;
        const cutoff = new Date(cutoffMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const lower = hasSince && since > cutoff ? since : cutoff;
        const placeholders = ownAreas.map(() => '?').join(',');
        const watchedRows = db.prepare(
            `SELECT id, slug, title, area, severity, state, raised_by, assigned_to, updated_at
               FROM issues
              WHERE area IN (${placeholders})
                AND updated_at > ?
              ORDER BY updated_at DESC
              LIMIT 15`
        ).all(...ownAreas, lower);
        out.watched_recent = watchedRows.map(r => ({
            issue_id: r.id, slug: r.slug, title: r.title, area: r.area,
            severity: r.severity, state: r.state,
            raised_by: r.raised_by, assigned_to: r.assigned_to,
            updated_at: r.updated_at
        }));
    }

    // Active decisions in my home area (accepted only). Always present (empty
    // list when there's no match). When `since` is provided we filter to the
    // delta — same idiom as the rest of the summary.
    const myArea = AGENT_TO_AREA[agent];
    if (myArea) {
        const decStmt = hasSince
            ? db.prepare(
                `SELECT id, slug, title, area, status, updated_at FROM decisions
                  WHERE status = 'accepted' AND area = ? AND updated_at > ?
                  ORDER BY updated_at DESC LIMIT 10`)
            : db.prepare(
                `SELECT id, slug, title, area, status, updated_at FROM decisions
                  WHERE status = 'accepted' AND area = ?
                  ORDER BY updated_at DESC LIMIT 10`);
        out.active_decisions_in_my_area = hasSince
            ? decStmt.all(myArea, since)
            : decStmt.all(myArea);
    } else {
        out.active_decisions_in_my_area = [];
    }

    // Cursor: max ts across everything we surfaced. Fall back to `since` (or
    // the current clock if no `since` given and no activity at all). Calling
    // back with this cursor must return an empty delta (idempotent no-op).
    let maxTs = hasSince ? since : null;
    const bump = (t) => { if (t && (!maxTs || t > maxTs)) maxTs = t; };
    for (const e of recent)   bump(e.ts);
    for (const m of inbox)    bump(m.ts);
    for (const i of myOpen)   bump(i.updated_at);
    if (out.pending_signoffs) for (const p of out.pending_signoffs) bump(p.since);
    if (out.watched_recent)    for (const w of out.watched_recent)    bump(w.updated_at);
    for (const d of out.active_decisions_in_my_area) bump(d.updated_at);
    out.cursor = maxTs || nowIso();

    return out;
}

export { AGENTS, VALID_AREAS, VALID_STATES, VALID_SEVERITY, VALID_OPS, VALID_VERDICTS, VALID_FILE_VERBS, VALID_DECISION_STATES, VALID_DECISION_VERDICTS };
