#!/usr/bin/env node
// metrics.js — read-only baseline metrics for the agent-comms event log.
//
// Usage:
//   node mcp-server/metrics.js              # markdown report on stdout
//   node mcp-server/metrics.js --json       # machine-readable JSON
//
// Computes three metrics from agent-comms/state.sqlite:
//   A. End-to-end latency per epic (max(ts) - min(ts), grouped by 'epic:<slug>' ref)
//   B. Signoff lead time (signoff.ts - matching awaiting_signoff issue-update.ts)
//   C. Parallel-call ratio (500ms tumbling windows per calling agent)

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DB_PATH    = process.env.AGENT_COMMS_DB_PATH
    ? resolve(process.env.AGENT_COMMS_DB_PATH)
    : resolve(__dirname, '..', 'agent-comms', 'state.sqlite');

const WINDOW_MS = 500;

function openReadonly(path) {
    // node:sqlite supports `readOnly` flag; if not, fall back to a default open
    // (DB writes here would still be blocked by our own discipline, not by the FS).
    try { return new DatabaseSync(path, { readOnly: true }); }
    catch { return new DatabaseSync(path); }
}

// ---------- Query A: per-epic end-to-end latency ----------
// `events.refs` is a JSON array of free-form strings. We expand it with
// json_each() and filter rows whose value starts with `epic:`. Each such
// string is treated as the epic identifier.
function queryEpicLatency(db) {
    const sql = `
        SELECT
            j.value                                  AS epic_slug,
            MIN(e.ts)                                AS first_ts,
            MAX(e.ts)                                AS last_ts,
            COUNT(*)                                 AS event_count
        FROM events e, json_each(e.refs) j
        WHERE e.refs IS NOT NULL
          AND j.value LIKE 'epic:%'
        GROUP BY j.value
        ORDER BY first_ts ASC
    `;
    const rows = db.prepare(sql).all();
    return rows.map(r => ({
        epic_slug:        r.epic_slug,
        first_ts:         r.first_ts,
        last_ts:          r.last_ts,
        event_count:      r.event_count,
        duration_seconds: (Date.parse(r.last_ts) - Date.parse(r.first_ts)) / 1000
    }));
}

// ---------- Query B: signoff lead time ----------
// For each signoff event, find the most recent prior `issue` event with
// op='update' whose payload.fields.awaiting_signoff is true and references
// the same issue_id. Lead time = signoff.ts - that update.ts.
function querySignoffLead(db) {
    const sql = `
        WITH input_required AS (
            SELECT
                json_extract(payload, '$.issue_id') AS issue_id,
                ts,
                agent
            FROM events
            WHERE kind = 'issue'
              AND json_extract(payload, '$.op') = 'update'
              AND json_extract(payload, '$.fields.awaiting_signoff') = 1
        ),
        signoffs AS (
            SELECT
                json_extract(payload, '$.issue_id') AS issue_id,
                ts,
                agent                              AS signer_agent
            FROM events
            WHERE kind = 'signoff'
        )
        SELECT
            s.issue_id,
            s.signer_agent,
            s.ts                                    AS signoff_ts,
            (SELECT MAX(ir.ts)
               FROM input_required ir
              WHERE ir.issue_id = s.issue_id
                AND ir.ts <= s.ts)                  AS input_required_ts
        FROM signoffs s
        ORDER BY s.ts ASC
    `;
    const rows = db.prepare(sql).all();
    return rows
        .filter(r => r.input_required_ts)
        .map(r => ({
            issue_id:     r.issue_id,
            signer_agent: r.signer_agent,
            signoff_ts:   r.signoff_ts,
            input_ts:     r.input_required_ts,
            lead_seconds: (Date.parse(r.signoff_ts) - Date.parse(r.input_required_ts)) / 1000
        }));
}

// ---------- Query C: parallel-call ratio (500 ms tumbling windows per agent) ----------
// SQLite's strftime() only exposes seconds; for sub-second windows we bucket
// in JS. Event ts is ISO-8601 (UTC, trailing Z) so Date.parse is lossless.
function queryParallelRatio(db) {
    const rows = db.prepare(
        'SELECT agent, ts FROM events ORDER BY agent, ts ASC'
    ).all();

    const buckets = new Map(); // agent -> Map<windowIdx, count>
    for (const r of rows) {
        const epochMs = Date.parse(r.ts);
        const win     = Math.floor(epochMs / WINDOW_MS);
        let perAgent  = buckets.get(r.agent);
        if (!perAgent) { perAgent = new Map(); buckets.set(r.agent, perAgent); }
        perAgent.set(win, (perAgent.get(win) || 0) + 1);
    }

    const out = [];
    for (const [agent, perAgent] of buckets) {
        const total    = perAgent.size;
        let parallel   = 0;
        for (const n of perAgent.values()) if (n >= 2) parallel++;
        out.push({
            agent,
            total_windows:    total,
            parallel_windows: parallel,
            ratio:            total ? parallel / total : 0
        });
    }
    out.sort((a, b) => b.ratio - a.ratio);
    return out;
}

// ---------- summary stats ----------
function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
}

function summarize(epicLatency, signoffLead, parallelRatio) {
    const epicDurs = epicLatency.map(e => e.duration_seconds).sort((a, b) => a - b);
    const leads    = signoffLead.map(s => s.lead_seconds).sort((a, b) => a - b);
    const ratios   = parallelRatio.map(p => p.ratio);
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    return {
        epic_count:           epicLatency.length,
        epic_avg_seconds:     avg(epicDurs),
        epic_p50_seconds:     percentile(epicDurs, 0.50),
        epic_p95_seconds:     percentile(epicDurs, 0.95),
        signoff_count:        signoffLead.length,
        signoff_avg_seconds:  avg(leads),
        signoff_p50_seconds:  percentile(leads, 0.50),
        signoff_p95_seconds:  percentile(leads, 0.95),
        agent_count:          parallelRatio.length,
        parallel_avg_ratio:   avg(ratios)
    };
}

// ---------- rendering ----------
function fmt(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
    return Number(n).toFixed(digits);
}

function renderMarkdown(epicLatency, signoffLead, parallelRatio, summary, generatedAt) {
    const lines = [];
    lines.push('# Agent-comms baseline metrics');
    lines.push('');
    lines.push(`Generated: ${generatedAt}`);
    lines.push(`DB: \`${DB_PATH}\``);
    lines.push('');

    lines.push('## A. End-to-end latency per epic');
    lines.push('');
    if (!epicLatency.length) {
        lines.push('_No events tagged with `epic:*` refs._');
    } else {
        lines.push('| epic_slug | first_ts | last_ts | duration_s | events |');
        lines.push('| --- | --- | --- | ---: | ---: |');
        for (const e of epicLatency) {
            lines.push(`| ${e.epic_slug} | ${e.first_ts} | ${e.last_ts} | ${fmt(e.duration_seconds)} | ${e.event_count} |`);
        }
    }
    lines.push('');

    lines.push('## B. Signoff lead time');
    lines.push('');
    if (!signoffLead.length) {
        lines.push('_No signoff events with a matching `awaiting_signoff=true` issue update found._');
    } else {
        lines.push('| issue_id | signer_agent | input_required_ts | signoff_ts | lead_s |');
        lines.push('| --- | --- | --- | --- | ---: |');
        for (const s of signoffLead) {
            lines.push(`| ${s.issue_id} | ${s.signer_agent} | ${s.input_ts} | ${s.signoff_ts} | ${fmt(s.lead_seconds)} |`);
        }
    }
    lines.push('');

    lines.push(`## C. Parallel-call ratio (${WINDOW_MS} ms tumbling windows)`);
    lines.push('');
    if (!parallelRatio.length) {
        lines.push('_No events in the DB._');
    } else {
        lines.push('| agent | total_windows | parallel_windows | ratio |');
        lines.push('| --- | ---: | ---: | ---: |');
        for (const p of parallelRatio) {
            lines.push(`| ${p.agent} | ${p.total_windows} | ${p.parallel_windows} | ${fmt(p.ratio, 3)} |`);
        }
    }
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push(`- Epics observed: **${summary.epic_count}**`);
    lines.push(`  - duration avg: ${fmt(summary.epic_avg_seconds)} s`);
    lines.push(`  - duration P50: ${fmt(summary.epic_p50_seconds)} s`);
    lines.push(`  - duration P95: ${fmt(summary.epic_p95_seconds)} s`);
    lines.push(`- Signoff pairs observed: **${summary.signoff_count}**`);
    lines.push(`  - lead avg: ${fmt(summary.signoff_avg_seconds)} s`);
    lines.push(`  - lead P50: ${fmt(summary.signoff_p50_seconds)} s`);
    lines.push(`  - lead P95: ${fmt(summary.signoff_p95_seconds)} s`);
    lines.push(`- Agents with events: **${summary.agent_count}**`);
    lines.push(`  - parallel-call ratio avg: ${fmt(summary.parallel_avg_ratio, 3)}`);
    lines.push('');
    return lines.join('\n');
}

// ---------- main ----------
function main() {
    const asJson = process.argv.includes('--json');
    const db = openReadonly(DB_PATH);
    let epicLatency, signoffLead, parallelRatio;
    try {
        epicLatency   = queryEpicLatency(db);
        signoffLead   = querySignoffLead(db);
        parallelRatio = queryParallelRatio(db);
    } finally {
        db.close();
    }
    const summary     = summarize(epicLatency, signoffLead, parallelRatio);
    const generatedAt = new Date().toISOString();

    if (asJson) {
        const payload = {
            generated_at: generatedAt,
            db_path:      DB_PATH,
            window_ms:    WINDOW_MS,
            epic_latency:  epicLatency,
            signoff_lead:  signoffLead,
            parallel_ratio: parallelRatio,
            summary
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    } else {
        process.stdout.write(renderMarkdown(epicLatency, signoffLead, parallelRatio, summary, generatedAt) + '\n');
    }
}

main();
