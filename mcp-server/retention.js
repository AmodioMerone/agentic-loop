#!/usr/bin/env node
// Retention sweep for the agent-comms SQLite DB.
//
// Deletes only low-value rows (kind='log' / 'file_change' older than N days)
// plus inbox_reads referencing events that no longer exist. NEVER touches
// audit-trail kinds ('issue', 'signoff', 'decision', 'message', 'claim'), and
// NEVER drops rows from issues / decisions / *_counters.
//
// Usage:
//   node retention.js [--dry-run] [--db <path>] [--days <N>] [--confirm]
//
// Rollback path: this script runs everything inside a single transaction.
// On --dry-run the txn is ROLLBACK'd. On a real run, a fatal error before
// COMMIT also leaves the DB untouched. To recover from a bad sweep, restore
// from the SQLite backup taken before the cron (devops runbook).

import { openDb } from './db.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, '..', 'agent-comms', 'state.sqlite');
const PRESERVED_KINDS = ['issue', 'signoff', 'decision', 'message', 'claim'];
const RETAINED_KINDS = ['log', 'file_change'];
const HIGH_WATERMARK = 10000;

function parseArgs(argv) {
    const args = { dryRun: false, db: DEFAULT_DB, days: 30, confirm: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--confirm') args.confirm = true;
        else if (a === '--db') args.db = argv[++i];
        else if (a === '--days') args.days = Number(argv[++i]);
        else throw new Error(`unknown arg: ${a}`);
    }
    if (!Number.isFinite(args.days) || args.days <= 0) {
        throw new Error(`--days must be a positive number; got: ${args.days}`);
    }
    return args;
}

function isoMinusDays(days) {
    const t = Date.now() - days * 86400 * 1000;
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const today = new Date().toISOString().slice(0, 10);
    const threshold = isoMinusDays(args.days);

    if (!existsSync(args.db)) {
        console.log(`no DB at ${args.db} — fresh install, nothing to retain`);
        return 0;
    }

    const db = openDb(args.db);

    // Safety: events table must exist (openDb creates it, but be defensive
    // for caller-supplied DBs that aren't ours).
    const hasEvents = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'"
    ).get();
    if (!hasEvents) {
        console.log('no events table — fresh DB, nothing to retain');
        return 0;
    }

    // Build per-kind candidate counts. Audit-trail kinds are never counted.
    const placeholders = RETAINED_KINDS.map(() => '?').join(',');
    const perKind = db.prepare(
        `SELECT kind, COUNT(*) AS n FROM events
          WHERE ts < ? AND kind IN (${placeholders})
          GROUP BY kind ORDER BY kind`
    ).all(threshold, ...RETAINED_KINDS);
    const orphanReads = db.prepare(
        `SELECT COUNT(*) AS n FROM inbox_reads
          WHERE event_id NOT IN (SELECT id FROM events)`
    ).get().n;

    const eventTotal = perKind.reduce((s, r) => s + r.n, 0);
    const grandTotal = eventTotal + orphanReads;

    if (!args.dryRun && grandTotal > HIGH_WATERMARK && !args.confirm) {
        console.log(`## Retention sweep (${today}, threshold=${args.days}d)`);
        for (const row of perKind) console.log(`- events.kind=${row.kind}: ${row.n} candidates older than ${threshold}`);
        console.log(`- inbox_reads orphans: ${orphanReads} candidates`);
        console.log(`WARNING: ${grandTotal} rows would be deleted (> ${HIGH_WATERMARK}). Re-run with --confirm or --dry-run.`);
        return 2;
    }

    // Execute (or simulate) in a single transaction so failures are atomic.
    let deletedEvents = 0;
    let deletedOrphans = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
        const delEvents = db.prepare(
            `DELETE FROM events WHERE ts < ? AND kind IN (${placeholders})`
        );
        deletedEvents = delEvents.run(threshold, ...RETAINED_KINDS).changes;
        const delOrphans = db.prepare(
            `DELETE FROM inbox_reads WHERE event_id NOT IN (SELECT id FROM events)`
        );
        deletedOrphans = delOrphans.run().changes;
        if (args.dryRun) db.exec('ROLLBACK');
        else db.exec('COMMIT');
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
    }

    const totalDeleted = args.dryRun ? 0 : (deletedEvents + deletedOrphans);
    console.log(`## Retention sweep (${today}, threshold=${args.days}d)`);
    if (perKind.length === 0) console.log(`- events: 0 candidates older than ${threshold}`);
    for (const row of perKind) console.log(`- events.kind=${row.kind}: ${row.n} candidates older than ${threshold}`);
    console.log(`- inbox_reads orphans: ${orphanReads} candidates`);
    console.log(`- preserved kinds (never deleted): ${PRESERVED_KINDS.join(', ')}`);
    console.log(`Total deleted: ${totalDeleted} rows (dry-run: ${args.dryRun ? grandTotal : 0})`);
    return 0;
}

try {
    process.exit(main());
} catch (e) {
    console.error(`retention error: ${e.message}`);
    process.exit(1);
}
