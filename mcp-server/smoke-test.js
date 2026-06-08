// Smoke test: spawns the server as a subprocess and sends JSON-RPC over stdio.
// Exercises: initialize, tools/list, tools/call (a handful), and verifies
// concurrency safety by firing parallel writes.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, 'server.js');
const DB_PATH = join(__dirname, 'smoke.sqlite');

// Reset
for (const ext of ['', '-wal', '-shm']) {
    const f = DB_PATH + ext;
    if (existsSync(f)) unlinkSync(f);
}

const proc = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: { ...process.env, AGENT_COMMS_DB: DB_PATH },
    stdio: ['pipe', 'pipe', 'pipe']
});
proc.stderr.on('data', d => process.stderr.write(`[srv] ${d}`));

let nextId = 1;
let buf = '';
const pending = new Map();
proc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
            const { resolve } = pending.get(msg.id);
            pending.delete(msg.id);
            resolve(msg);
        }
    }
});

function rpc(method, params) {
    const id = nextId++;
    return new Promise(resolve => {
        pending.set(id, { resolve });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
}

function call(name, args) {
    return rpc('tools/call', { name, arguments: args });
}

const ASSERT = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// nowIso() in db.js strips millis, so events created within the same wall-clock
// second share a ts. Cursor comparison uses strict `>`, so we must wait until
// the next second boundary between a snapshot and any events that should land
// in the delta of that snapshot's cursor.
const sleepPastSecond = () => new Promise(r => {
    const ms = 1000 - (Date.now() % 1000) + 50;
    setTimeout(r, ms);
});

// Mirror db.js nowIso(): seconds-resolution ISO. Used by tests that need to
// build a `since` cursor on the client side without round-tripping via tools.
const nowIsoForTest = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

(async () => {
    // 1. initialize
    const init = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0.0.1' }
    });
    ASSERT(init.result, 'initialize returned ' + JSON.stringify(init));
    console.log('OK initialize:', init.result.serverInfo?.name);

    // tools/list
    const list = await rpc('tools/list', {});
    ASSERT(list.result?.tools?.length >= 10, 'expected at least 10 tools');
    console.log('OK tools/list:', list.result.tools.length, 'tools');

    // 2. empty summary
    const s0 = await call('state_summary', { agent: 'backend-senior-dev' });
    ASSERT(s0.result?.structuredContent?.unread_count === 0, 'unread should be 0');
    console.log('OK state_summary: 0 unread');

    // 3. open an issue from backend, assigned to qa
    const opened = await call('open_issue', {
        raised_by: 'backend-senior-dev',
        area: 'qa',
        title: 'Add tests for POST /follow',
        body: 'Cover happy/dup/self/anon',
        severity: 'low',
        assigned_to: 'qa-specialist'
    });
    console.log('DEBUG open_issue response:', JSON.stringify(opened, null, 2));
    const sc = opened.result.structuredContent || JSON.parse(opened.result.content[0].text);
    const ISS = sc.issue_id;
    ASSERT(ISS && ISS.startsWith('ISS-'), 'expected ISS-id, got ' + JSON.stringify(opened));
    console.log('OK open_issue:', ISS);

    // 4. record file change
    const fc = await call('record_file_change', {
        agent: 'backend-senior-dev',
        path: 'server/routes/follow.ts',
        verb: 'add',
        why: 'implement POST /api/v1/follow'
    });
    ASSERT(fc.result?.structuredContent?.event_id, 'expected event_id from record_file_change');
    console.log('OK record_file_change');

    // 5. send a message
    const msg = await call('send_message', {
        from: 'backend-senior-dev',
        to: ['qa-specialist'],
        re: ISS,
        body: 'Please integration test happy/dup/self/anon paths.'
    });
    ASSERT(msg.result?.structuredContent?.event_id, 'send_message');
    console.log('OK send_message');

    // 6. log sign-off
    await call('log', { agent: 'backend-senior-dev', summary: 'added endpoint + dispatched QA', refs: ['server/routes/follow.ts', ISS] });
    console.log('OK log');

    // 7. now as qa: state_summary should show 1 unread + 1 open issue
    const sQ = await call('state_summary', { agent: 'qa-specialist' });
    ASSERT(sQ.result.structuredContent.unread_count === 1, 'qa unread should be 1, got ' + sQ.result.structuredContent.unread_count);
    ASSERT(sQ.result.structuredContent.my_open_issues.length === 1, 'qa should have 1 open issue');
    console.log('OK qa state_summary: 1 unread, 1 open');

    // 8. qa claims the issue (transition: submitted -> working, takes ownership)
    const claim = await call('transition_issue', { issue_id: ISS, by: 'qa-specialist', op: 'claim' });
    ASSERT(claim.result.structuredContent.new_state === 'working', 'expected state=working after claim');
    ASSERT(claim.result.structuredContent.assigned_to === 'qa-specialist', 'qa owns it');
    console.log('OK transition claim -> working');

    // 9. unauthorized transition test: tech-writer tries to resolve qa's issue -> should fail
    const bad = await call('transition_issue', { issue_id: ISS, by: 'tech-writer', op: 'resolve' });
    ASSERT(bad.result.isError === true, 'unauthorized transition should be an error');
    console.log('OK ownership guard rejects unauthorized agent');

    // 10. invalid state machine: tech-writer can't even start because not owner. Try owner with invalid jump.
    const badJump = await call('transition_issue', { issue_id: ISS, by: 'qa-specialist', op: 'update', fields: { state: 'submitted' } });
    ASSERT(badJump.result.isError === true, 'expected invalid transition error');
    console.log('OK state machine rejects invalid transition');

    // 11a. phase-gate negative: ISS is area=qa, so resolve without signoff must fail
    const noSig = await call('transition_issue', { issue_id: ISS, by: 'qa-specialist', op: 'resolve' });
    ASSERT(noSig.result.isError === true, 'expected phase-gate error for qa area without signoff');
    ASSERT((noSig.result.content[0].text || '').includes('signoff'),
        'phase-gate error should mention signoff, got: ' + noSig.result.content[0].text);
    console.log('OK phase-gate blocks resolve without signoff (qa)');

    // 11b. add the signoff from review-architect, then resolve should succeed
    await call('signoff', { agent: 'review-architect', issue_id: ISS, verdict: 'approved', note: 'qa coverage acceptable' });
    const resolved = await call('transition_issue', { issue_id: ISS, by: 'qa-specialist', op: 'resolve', note: 'tests added' });
    ASSERT(resolved.result.structuredContent.new_state === 'completed', 'resolved should be completed');
    console.log('OK transition resolve -> completed (with required signoff)');

    // 11c. issues_get history now includes the signoff event alongside issue transitions
    const issDetail = await call('issues_get', { issue_id: ISS });
    const hist = issDetail.result.structuredContent.history || [];
    const kinds = hist.map(h => h.kind);
    ASSERT(kinds.includes('signoff'), 'history should include a signoff event; got kinds: ' + kinds.join(','));
    ASSERT(kinds.includes('issue'),   'history should include issue events too');
    console.log('OK issues_get.history merges issue + signoff events');

    // 11d. dependency enforcement: B depends_on [A], cannot resolve B until A is completed.
    const A = await call('open_issue', {
        raised_by: 'backend-senior-dev', area: 'backend',
        title: 'dep-A', assigned_to: 'backend-senior-dev'
    });
    const A_ID = A.result.structuredContent.issue_id;
    const B = await call('open_issue', {
        raised_by: 'backend-senior-dev', area: 'backend',
        title: 'dep-B depends on A', assigned_to: 'backend-senior-dev',
        depends_on: [A_ID]
    });
    const B_ID = B.result.structuredContent.issue_id;
    await call('transition_issue', { issue_id: A_ID, by: 'backend-senior-dev', op: 'claim' });
    await call('transition_issue', { issue_id: B_ID, by: 'backend-senior-dev', op: 'claim' });
    // try to resolve B before A
    const earlyB = await call('transition_issue', { issue_id: B_ID, by: 'backend-senior-dev', op: 'resolve' });
    ASSERT(earlyB.result.isError === true, 'expected dependency error');
    ASSERT((earlyB.result.content[0].text || '').includes('depend'),
        'dependency error should mention depend, got: ' + earlyB.result.content[0].text);
    console.log('OK dependency blocks resolve when dependency is not completed');
    // resolve A, then B
    await call('transition_issue', { issue_id: A_ID, by: 'backend-senior-dev', op: 'resolve' });
    const goodB = await call('transition_issue', { issue_id: B_ID, by: 'backend-senior-dev', op: 'resolve' });
    ASSERT(goodB.result.structuredContent?.new_state === 'completed', 'B should resolve once A is complete');
    console.log('OK dependency satisfied: B resolves after A');

    // 11e. Issue slugs: openIssue computes a kebab-case slug, getIssue & transitionIssue accept it.
    const S1 = await call('open_issue', {
        raised_by: 'backend-senior-dev', area: 'backend',
        title: 'Refactor auth middleware for compliance',
        assigned_to: 'backend-senior-dev'
    });
    const S1_SC = S1.result.structuredContent;
    ASSERT(S1_SC.issue_id && S1_SC.issue_id.startsWith('ISS-'), 'slug-test: expected ISS-id');
    ASSERT(S1_SC.slug === 'refactor-auth-middleware',
        'expected slug "refactor-auth-middleware", got ' + JSON.stringify(S1_SC.slug));
    console.log('OK open_issue computed slug:', S1_SC.slug);

    // Collision: same title -> second issue gets -2 suffix
    const S2 = await call('open_issue', {
        raised_by: 'backend-senior-dev', area: 'backend',
        title: 'Refactor auth middleware for compliance',
        assigned_to: 'backend-senior-dev'
    });
    const S2_SC = S2.result.structuredContent;
    ASSERT(S2_SC.slug && S2_SC.slug.endsWith('-2'),
        'expected collision suffix -2, got ' + JSON.stringify(S2_SC.slug));
    ASSERT(S2_SC.slug !== S1_SC.slug, 'slugs must be unique across rows');
    console.log('OK collision suffix:', S2_SC.slug);

    // issues_get works with both ID and slug, returning the same row.
    const bySlug = await call('issues_get', { issue_id: S1_SC.slug });
    const byId   = await call('issues_get', { issue_id: S1_SC.issue_id });
    ASSERT(bySlug.result.structuredContent.id === S1_SC.issue_id,
        'issues_get(slug) should return same row id');
    ASSERT(byId.result.structuredContent.id   === S1_SC.issue_id,
        'issues_get(id) should return same row id');
    ASSERT(bySlug.result.structuredContent.slug === S1_SC.slug,
        'issues_get(slug) should expose slug field');
    console.log('OK issues_get accepts both slug and ISS-id');

    // transition_issue accepts a slug
    const slugClaim = await call('transition_issue', {
        issue_id: S1_SC.slug, by: 'backend-senior-dev', op: 'claim'
    });
    ASSERT(slugClaim.result.structuredContent?.new_state === 'working',
        'transition_issue(slug) claim should reach working; got ' + JSON.stringify(slugClaim.result));
    console.log('OK transition_issue accepts slug');

    // 11f. Phase-gate push (qa): owner flips fields.awaiting_signoff -> auto-message to review-architect.
    const Q = await call('open_issue', {
        raised_by: 'backend-senior-dev', area: 'qa',
        title: 'phase-gate qa push', assigned_to: 'qa-specialist'
    });
    const Q_ID = Q.result.structuredContent.issue_id;
    await call('transition_issue', { issue_id: Q_ID, by: 'qa-specialist', op: 'claim' });
    const pushQ = await call('transition_issue', {
        issue_id: Q_ID, by: 'qa-specialist', op: 'update',
        fields: { state: 'input_required', awaiting_signoff: true }
    });
    ASSERT(pushQ.result.structuredContent?.new_state === 'input_required',
        'expected new_state=input_required after push; got ' + JSON.stringify(pushQ.result));
    ASSERT(pushQ.result.structuredContent?.auto_message_event_id,
        'expected auto_message_event_id on transition response');
    // Verify the message landed in events with the right shape.
    const inboxRA = await call('inbox_list', { agent: 'review-architect', limit: 50 });
    const ra_items = inboxRA.result.structuredContent?.items
        || JSON.parse(inboxRA.result.content[0].text);
    const qMsg = ra_items.find(m => m.payload?.re === Q_ID);
    ASSERT(qMsg, 'review-architect inbox should contain a message re ' + Q_ID);
    ASSERT(Array.isArray(qMsg.payload.to) && qMsg.payload.to.includes('review-architect'),
        'message.to should include review-architect');
    ASSERT(Array.isArray(qMsg.refs) && qMsg.refs.includes(Q_ID),
        'message.refs should include the issue id');
    console.log('OK auto-message to review-architect on qa push');

    // 11g. Phase-gate push (security): same flow, but the signer is security-auditor.
    const SEC = await call('open_issue', {
        raised_by: 'backend-senior-dev', area: 'security',
        title: 'phase-gate security push', assigned_to: 'security-auditor'
    });
    const SEC_ID = SEC.result.structuredContent.issue_id;
    await call('transition_issue', { issue_id: SEC_ID, by: 'security-auditor', op: 'claim' });
    const pushS = await call('transition_issue', {
        issue_id: SEC_ID, by: 'security-auditor', op: 'update',
        fields: { state: 'input_required', awaiting_signoff: true }
    });
    ASSERT(pushS.result.structuredContent?.auto_message_event_id,
        'security push should emit auto-message');
    const inboxSA = await call('inbox_list', { agent: 'security-auditor', limit: 50 });
    const sa_items = inboxSA.result.structuredContent?.items
        || JSON.parse(inboxSA.result.content[0].text);
    const sMsg = sa_items.find(m => m.payload?.re === SEC_ID);
    ASSERT(sMsg, 'security-auditor inbox should contain a message re ' + SEC_ID);
    ASSERT(sMsg.payload.to.includes('security-auditor') && sMsg.payload.to.length === 1,
        'security push should target security-auditor only');
    console.log('OK auto-message to security-auditor on security push');

    // 11h. pending_signoffs visibility: only signers see the field.
    const raSum = await call('state_summary', { agent: 'review-architect' });
    const raPending = raSum.result.structuredContent?.pending_signoffs;
    ASSERT(Array.isArray(raPending),
        'review-architect state_summary should expose pending_signoffs array');
    ASSERT(raPending.some(p => p.issue_id === Q_ID),
        'review-architect pending_signoffs should include ' + Q_ID);
    const beSum = await call('state_summary', { agent: 'backend-senior-dev' });
    ASSERT(!('pending_signoffs' in (beSum.result.structuredContent || {})),
        'non-signer state_summary must omit pending_signoffs entirely');
    console.log('OK pending_signoffs visible to signer only');

    // 11i. Idempotency: re-emitting the same awaiting_signoff flag does NOT create a second message.
    const beforeCount = (await call('inbox_list', { agent: 'review-architect', limit: 100 }))
        .result.structuredContent?.items.filter(m => m.payload?.re === Q_ID).length;
    // Issue is currently input_required; bounce it back to working then push again.
    await call('transition_issue', { issue_id: Q_ID, by: 'qa-specialist', op: 'update', fields: { state: 'working' } });
    const pushAgain = await call('transition_issue', {
        issue_id: Q_ID, by: 'qa-specialist', op: 'update',
        fields: { state: 'input_required', awaiting_signoff: true }
    });
    ASSERT(pushAgain.result.structuredContent?.auto_message_event_id === null,
        'second push within 24h should be a no-op; got ' + JSON.stringify(pushAgain.result.structuredContent));
    const afterCount = (await call('inbox_list', { agent: 'review-architect', limit: 100 }))
        .result.structuredContent?.items.filter(m => m.payload?.re === Q_ID).length;
    ASSERT(afterCount === beforeCount,
        `idempotency: expected ${beforeCount} messages re ${Q_ID}, got ${afterCount}`);
    console.log('OK auto-message is idempotent within 24h');

    // 11j. feature-owner can use the protocol (registered as a first-class agent).
    const foLog = await call('log', { agent: 'feature-owner', summary: 'smoke: feature-owner can log', refs: [] });
    ASSERT(foLog.result?.structuredContent?.event_id, 'feature-owner log should return event_id');
    const foFc = await call('record_file_change', {
        agent: 'feature-owner', path: 'plans/test.md', verb: 'add', why: 'smoke'
    });
    ASSERT(foFc.result?.structuredContent?.event_id, 'feature-owner record_file_change should return event_id');
    const foSum = await call('state_summary', { agent: 'feature-owner' });
    const foSumSc = foSum.result?.structuredContent;
    ASSERT(foSumSc && typeof foSumSc.unread_count === 'number',
        'feature-owner state_summary should return a valid structure');
    ASSERT(Array.isArray(foSumSc.my_open_issues), 'feature-owner my_open_issues should be an array');
    const foMsg = await call('send_message', {
        from: 'feature-owner', to: ['backend-senior-dev'], body: 'smoke: hello from feature-owner'
    });
    ASSERT(foMsg.result?.structuredContent?.event_id, 'feature-owner send_message should return event_id');
    const foIss = await call('open_issue', {
        raised_by: 'feature-owner', area: 'arch',
        title: 'smoke: feature-owner can open issue', assigned_to: 'review-architect'
    });
    ASSERT(foIss.result?.structuredContent?.issue_id?.startsWith('ISS-'),
        'feature-owner open_issue should return an ISS-id');
    console.log('OK feature-owner uses protocol (log, record_file_change, state_summary, send_message, open_issue)');

    // 11k. state_summary delta correctness: `since` filters to events strictly
    //      after the cursor, and re-calling with the new cursor returns empty.
    await sleepPastSecond();
    const sd0 = await call('state_summary', { agent: 'backend-senior-dev' });
    const sd0sc = sd0.result.structuredContent;
    ASSERT(typeof sd0sc.cursor === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(sd0sc.cursor),
        'state_summary should always return an ISO cursor; got ' + JSON.stringify(sd0sc.cursor));
    const baseCursor = sd0sc.cursor;
    await sleepPastSecond();
    // Create 5 new events (mix: log, file_change, message) as backend-senior-dev.
    await call('log', { agent: 'backend-senior-dev', summary: 'delta: log 1' });
    await call('record_file_change', { agent: 'backend-senior-dev', path: 'delta/a.ts', verb: 'add', why: 'delta test' });
    await call('record_file_change', { agent: 'backend-senior-dev', path: 'delta/b.ts', verb: 'edit', why: 'delta test' });
    await call('send_message', { from: 'backend-senior-dev', to: ['qa-specialist'], body: 'delta: ping 1' });
    await call('log', { agent: 'backend-senior-dev', summary: 'delta: log 2' });
    const sd1 = await call('state_summary', { agent: 'backend-senior-dev', since: baseCursor });
    const sd1sc = sd1.result.structuredContent;
    ASSERT(sd1sc.recent_activity.length === 5,
        'delta: expected exactly 5 new events, got ' + sd1sc.recent_activity.length + ': ' + JSON.stringify(sd1sc.recent_activity));
    ASSERT(sd1sc.cursor > baseCursor,
        `delta: cursor should advance; ${baseCursor} -> ${sd1sc.cursor}`);
    for (const e of sd1sc.recent_activity) {
        ASSERT(e.ts > baseCursor, 'delta: every event ts must be > baseCursor; offender ' + e.ts);
    }
    console.log('OK state_summary delta: 5 new events captured, cursor advanced');
    // Re-call with the fresh cursor: no new activity should appear.
    const sd2 = await call('state_summary', { agent: 'backend-senior-dev', since: sd1sc.cursor });
    const sd2sc = sd2.result.structuredContent;
    ASSERT(sd2sc.recent_activity.length === 0,
        'delta: re-call with fresh cursor should return 0 events, got ' + sd2sc.recent_activity.length);
    ASSERT(sd2sc.unread_count === 0,
        'delta: re-call should report 0 unread delta, got ' + sd2sc.unread_count);
    console.log('OK state_summary delta is idempotent (empty on re-call)');
    // One more event after the empty delta should appear in the next call.
    await sleepPastSecond();
    await call('log', { agent: 'backend-senior-dev', summary: 'delta: post-empty bump' });
    const sd3 = await call('state_summary', { agent: 'backend-senior-dev', since: sd2sc.cursor });
    const sd3sc = sd3.result.structuredContent;
    ASSERT(sd3sc.recent_activity.length === 1,
        'delta: expected 1 event after second bump, got ' + sd3sc.recent_activity.length);
    ASSERT(sd3sc.cursor > sd2sc.cursor, 'delta: cursor must advance after new activity');
    console.log('OK state_summary delta picks up new activity after empty cycle');

    // 11l. Cross-area E2E: exercise P0-3 (signoff gate) + P0-4 (phase-gate push
    //      auto-message) + P0-5 (delta cursor) under a single epic ref.
    const EPIC = 'epic:cross-test';
    // feature-owner opens 2 issues — one backend, one frontend — both tagged with the epic.
    const eBe = await call('open_issue', {
        raised_by: 'feature-owner', area: 'backend',
        title: 'cross-test: backend slice', assigned_to: 'backend-senior-dev',
        refs: [EPIC]
    });
    const eFe = await call('open_issue', {
        raised_by: 'feature-owner', area: 'frontend',
        title: 'cross-test: frontend slice', assigned_to: 'frontend-senior-dev',
        refs: [EPIC]
    });
    const BE_ID = eBe.result.structuredContent.issue_id;
    const FE_ID = eFe.result.structuredContent.issue_id;
    ASSERT(BE_ID && FE_ID, 'cross-test: both issues should have ISS-ids');
    // backend-senior-dev claims + records a file change + transitions update with
    // awaiting_signoff=true. area=backend is NOT in SIGNERS_BY_AREA, so no auto-message.
    await call('transition_issue', { issue_id: BE_ID, by: 'backend-senior-dev', op: 'claim' });
    await call('record_file_change', {
        agent: 'backend-senior-dev', path: 'cross/backend.ts', verb: 'add', why: 'cross-test slice'
    });
    const bePush = await call('transition_issue', {
        issue_id: BE_ID, by: 'backend-senior-dev', op: 'update',
        fields: { state: 'input_required', awaiting_signoff: true }
    });
    ASSERT(bePush.result.structuredContent?.auto_message_event_id === null,
        'cross-test: area=backend awaiting_signoff must NOT emit an auto-message; got ' + JSON.stringify(bePush.result.structuredContent));
    console.log('OK cross-test: area=backend awaiting_signoff is a no-op (no signer mapped)');
    // Open a 3rd issue area=qa assigned to qa-specialist; claim + push -> auto-message to review-architect.
    const eQa = await call('open_issue', {
        raised_by: 'feature-owner', area: 'qa',
        title: 'cross-test: qa coverage', assigned_to: 'qa-specialist',
        refs: [EPIC]
    });
    const QA_ID = eQa.result.structuredContent.issue_id;
    await call('transition_issue', { issue_id: QA_ID, by: 'qa-specialist', op: 'claim' });
    const qaPush = await call('transition_issue', {
        issue_id: QA_ID, by: 'qa-specialist', op: 'update',
        fields: { state: 'input_required', awaiting_signoff: true }
    });
    ASSERT(qaPush.result.structuredContent?.auto_message_event_id,
        'cross-test: area=qa awaiting_signoff must emit auto-message to review-architect');
    console.log('OK cross-test: area=qa push emits auto-message to review-architect');
    // review-architect state_summary must list QA_ID in pending_signoffs.
    const raSum2 = await call('state_summary', { agent: 'review-architect' });
    const raPending2 = raSum2.result.structuredContent?.pending_signoffs || [];
    ASSERT(raPending2.some(p => p.issue_id === QA_ID),
        'cross-test: review-architect pending_signoffs should include ' + QA_ID + '; got ' + JSON.stringify(raPending2));
    console.log('OK cross-test: review-architect sees QA issue in pending_signoffs');
    // review-architect signs off, then qa-specialist resolves successfully.
    await call('signoff', { agent: 'review-architect', issue_id: QA_ID, verdict: 'approved', note: 'cross-test approved' });
    // resolve requires state=working (qa is currently input_required). Bounce back first.
    await call('transition_issue', {
        issue_id: QA_ID, by: 'qa-specialist', op: 'update', fields: { state: 'working' }
    });
    const qaResolve = await call('transition_issue', {
        issue_id: QA_ID, by: 'qa-specialist', op: 'resolve', note: 'cross-test done'
    });
    ASSERT(qaResolve.result.structuredContent?.new_state === 'completed',
        'cross-test: qa resolve after signoff should reach completed; got ' + JSON.stringify(qaResolve.result));
    console.log('OK cross-test: qa resolves after review-architect signoff');
    // Verify all three issues share the epic ref (metrics.js consumer can group on this).
    const epicCheck = await call('issues_list', { limit: 200 });
    const epicItems = (epicCheck.result.structuredContent?.items
        || JSON.parse(epicCheck.result.content[0].text));
    const epicIssues = epicItems.filter(i => Array.isArray(i.refs) && i.refs.includes(EPIC));
    ASSERT(epicIssues.length === 3,
        `cross-test: expected 3 issues tagged ${EPIC}, got ${epicIssues.length}`);
    console.log('OK cross-test: 3 issues share', EPIC, 'epic ref');

    // 11m. decisions lifecycle: record -> ownership guard -> approve -> supersede -> list -> get -> stateSummary
    // We snapshot preDecCursor first, then wait past the next second so all
    // subsequent decision events satisfy `updated_at > preDecCursor` strictly.
    const preDecCursor = nowIsoForTest();
    await sleepPastSecond();
    // (1) record initial decision
    const dec1 = await call('decision_record', {
        raised_by: 'review-architect', area: 'backend',
        title: 'Choose JWT over sessions',
        context: 'We need stateless auth across services.',
        decision: 'Adopt JWT for service-to-service auth.',
        consequences: 'Stateless servers; rotate signing keys quarterly.'
    });
    const dec1sc = dec1.result.structuredContent;
    ASSERT(dec1sc?.decision_id && /^DEC-\d{8}-\d{3}$/.test(dec1sc.decision_id),
        'decisions: expected DEC-id format, got ' + JSON.stringify(dec1sc));
    ASSERT(dec1sc.slug === 'choose-jwt-over-sessions',
        'decisions: expected slug "choose-jwt-over-sessions", got ' + JSON.stringify(dec1sc.slug));
    const DEC1 = dec1sc.decision_id;
    // also verify the row is 'proposed'
    const dec1get = await call('decisions_get', { decision_id: DEC1 });
    ASSERT(dec1get.result.structuredContent?.status === 'proposed',
        'decisions: newly recorded decision should be proposed');
    console.log('OK decision_record DEC1:', DEC1, dec1sc.slug);

    // (2) ownership guard: a non-architect cannot approve
    const badApprove = await call('decision_approve', {
        by: 'backend-senior-dev', decision_id: DEC1, verdict: 'approve'
    });
    ASSERT(badApprove.result.isError === true,
        'decisions: non-architect approval must fail');
    ASSERT((badApprove.result.content[0].text || '').includes('review-architect'),
        'decisions: ownership error should mention review-architect');
    console.log('OK decision_approve ownership guard rejects non-architect');

    // (3) architect approves -> accepted
    const okApprove = await call('decision_approve', {
        by: 'review-architect', decision_id: DEC1, verdict: 'approve', note: 'lgtm'
    });
    ASSERT(okApprove.result.structuredContent?.status === 'accepted',
        'decisions: expected status=accepted; got ' + JSON.stringify(okApprove.result));
    console.log('OK decision_approve -> accepted');

    // (4) record a superseding decision
    const dec2 = await call('decision_record', {
        raised_by: 'review-architect', area: 'backend',
        title: 'Switch JWT to PASETO',
        context: 'JWT has footguns; PASETO is safer by default.',
        decision: 'Migrate auth to PASETO v4.',
        supersedes: DEC1
    });
    const dec2sc = dec2.result.structuredContent;
    ASSERT(dec2sc?.decision_id?.startsWith('DEC-'),
        'decisions: expected DEC-id on supersede; got ' + JSON.stringify(dec2sc));
    const DEC2 = dec2sc.decision_id;
    // After record, DEC1 must still be 'accepted' (supersede only fires on approve)
    const dec1afterRecord = await call('decisions_get', { decision_id: DEC1 });
    ASSERT(dec1afterRecord.result.structuredContent?.status === 'accepted',
        'decisions: predecessor must stay accepted until successor is approved');
    console.log('OK decision_record (supersedes) keeps predecessor accepted');

    // (5) approve DEC2 -> DEC2 accepted AND DEC1 flipped to superseded
    const okApprove2 = await call('decision_approve', {
        by: 'review-architect', decision_id: DEC2, verdict: 'approve'
    });
    const okApprove2sc = okApprove2.result.structuredContent;
    ASSERT(okApprove2sc?.status === 'accepted',
        'decisions: DEC2 should be accepted; got ' + JSON.stringify(okApprove2sc));
    ASSERT(okApprove2sc?.superseded_id === DEC1,
        'decisions: approve(DEC2) should return superseded_id=DEC1; got ' + JSON.stringify(okApprove2sc));
    const dec1Final = await call('decisions_get', { decision_id: DEC1 });
    ASSERT(dec1Final.result.structuredContent?.status === 'superseded',
        'decisions: predecessor must now be superseded; got ' + JSON.stringify(dec1Final.result.structuredContent?.status));
    console.log('OK approve cascades to supersede predecessor');

    // (6) decisions_list filter by status=accepted should include only DEC2
    const listAccepted = await call('decisions_list', { status: 'accepted' });
    const acceptedItems = listAccepted.result.structuredContent?.items
        || JSON.parse(listAccepted.result.content[0].text);
    ASSERT(acceptedItems.some(d => d.id === DEC2),
        'decisions_list(status=accepted) should include DEC2');
    ASSERT(!acceptedItems.some(d => d.id === DEC1),
        'decisions_list(status=accepted) must NOT include DEC1 (now superseded)');
    console.log('OK decisions_list filters by status');

    // (7) decisions_get(DEC1) has full history: record + approve + (auto)supersede on approve(DEC2)
    const dec1Hist = (dec1Final.result.structuredContent.history || []);
    ASSERT(dec1Hist.length >= 3,
        'decisions_get history for DEC1 should have at least 3 events (record + approve + supersede), got ' + dec1Hist.length);
    const dec1Ops = dec1Hist.map(h => h.op);
    ASSERT(dec1Ops.includes('record') && dec1Ops.includes('approve'),
        'decisions: DEC1 history must include record + approve ops; got ' + dec1Ops.join(','));
    console.log('OK decisions_get history for DEC1: ops =', dec1Ops.join(','));

    // (8) backend-senior-dev state_summary surfaces DEC2 (area=backend, status=accepted)
    const beStateDec = await call('state_summary', { agent: 'backend-senior-dev' });
    const beDecs = beStateDec.result.structuredContent?.active_decisions_in_my_area;
    ASSERT(Array.isArray(beDecs),
        'state_summary: active_decisions_in_my_area must be an array; got ' + JSON.stringify(beDecs));
    ASSERT(beDecs.some(d => d.id === DEC2),
        'state_summary(backend): should include DEC2; got ' + JSON.stringify(beDecs));
    ASSERT(!beDecs.some(d => d.id === DEC1),
        'state_summary(backend): must NOT include DEC1 (superseded); got ' + JSON.stringify(beDecs));
    console.log('OK state_summary surfaces accepted decisions in my area');

    // (9) Delta correctness: a `since` before record sees DEC2; after sees none.
    const beforeDelta = await call('state_summary', { agent: 'backend-senior-dev', since: preDecCursor });
    const beforeDecs = beforeDelta.result.structuredContent?.active_decisions_in_my_area || [];
    ASSERT(beforeDecs.some(d => d.id === DEC2),
        'state_summary delta(before): should include DEC2');
    const afterDelta = await call('state_summary', {
        agent: 'backend-senior-dev', since: beStateDec.result.structuredContent.cursor
    });
    const afterDecs = afterDelta.result.structuredContent?.active_decisions_in_my_area || [];
    ASSERT(afterDecs.length === 0,
        'state_summary delta(after): should be empty; got ' + JSON.stringify(afterDecs));
    console.log('OK active_decisions_in_my_area honors the since cursor');

    // 11n. route_task: deterministic lexical scoring against capability cards.
    const rt1 = await call('route_task', {
        task: 'Add a new REST endpoint for user signup', hints: { area: 'backend' }
    });
    const rt1sc = rt1.result.structuredContent;
    ASSERT(rt1sc?.recommended_agent === 'backend-senior-dev',
        'route_task: REST endpoint + area=backend should -> backend-senior-dev; got ' + JSON.stringify(rt1sc));
    ASSERT(Array.isArray(rt1sc.runners_up) && rt1sc.runners_up.length === 2,
        'route_task: runners_up should be a 2-element array; got ' + JSON.stringify(rt1sc.runners_up));
    console.log('OK route_task: backend (rest + area=backend)');

    const rt2 = await call('route_task', {
        task: 'Fix accessibility on the login form button',
        hints: { files: ['app/components/LoginForm.tsx'] }
    });
    const rt2sc = rt2.result.structuredContent;
    ASSERT(rt2sc?.recommended_agent === 'frontend-senior-dev',
        'route_task: .tsx file hint should -> frontend-senior-dev; got ' + JSON.stringify(rt2sc));
    console.log('OK route_task: frontend (a11y + .tsx file)');

    const rt3 = await call('route_task', { task: 'Audit JWT secret rotation policy' });
    const rt3sc = rt3.result.structuredContent;
    const rt3Top = [rt3sc.recommended_agent, ...rt3sc.runners_up.map(r => r.name)];
    ASSERT(rt3Top.includes('security-auditor'),
        'route_task: secrets/audit task should surface security-auditor in top 3; got ' + JSON.stringify(rt3Top));
    console.log('OK route_task: security in top 3 (no hints)');

    // Edge case: very vague task should still return a result (no error), even with score=0.
    const rt4 = await call('route_task', { task: 'do the thing' });
    ASSERT(!rt4.result.isError, 'route_task: vague task must not error');
    ASSERT(typeof rt4.result.structuredContent?.recommended_agent === 'string',
        'route_task: vague task should still recommend somebody');
    console.log('OK route_task: vague task returns a recommendation (score:', rt4.result.structuredContent.score, ')');

    // 11o. events_recent severity_min: filter by issue payload severity, exclude unannotated events.
    // Open 4 issues spanning the severity spectrum.
    for (const sev of ['critical', 'high', 'medium', 'low']) {
        await call('open_issue', {
            raised_by: 'backend-senior-dev', area: 'backend',
            title: `sev-test ${sev}`, assigned_to: 'backend-senior-dev',
            severity: sev
        });
    }
    // medium threshold: should include critical + high + medium = 3 issue events.
    // (Log/file_change/message events created earlier carry no severity and must be excluded.)
    const sevMed = await call('events_recent', { severity_min: 'medium', limit: 200 });
    const sevMedItems = sevMed.result.structuredContent?.items
        || JSON.parse(sevMed.result.content[0].text);
    const sevMedKinds = new Set(sevMedItems.map(e => e.kind));
    ASSERT(sevMedItems.length >= 3,
        'events_recent(severity_min=medium): expected >= 3 events; got ' + sevMedItems.length);
    ASSERT([...sevMedKinds].every(k => k === 'issue'),
        'events_recent(severity_min=medium): every returned event should be kind=issue; got kinds ' + [...sevMedKinds].join(','));
    const sevMedSeverities = sevMedItems
        .map(e => e.payload?.severity)
        .filter(Boolean);
    for (const s of sevMedSeverities) {
        ASSERT(['critical','high','medium'].includes(s),
            'events_recent(severity_min=medium): event severity ' + s + ' must be >= medium');
    }
    // Critical threshold: only the critical issue.
    const sevCrit = await call('events_recent', { severity_min: 'critical', limit: 200 });
    const sevCritItems = sevCrit.result.structuredContent?.items
        || JSON.parse(sevCrit.result.content[0].text);
    ASSERT(sevCritItems.length >= 1,
        'events_recent(severity_min=critical): expected >= 1 critical issue; got ' + sevCritItems.length);
    for (const e of sevCritItems) {
        ASSERT(e.payload?.severity === 'critical',
            'events_recent(severity_min=critical): non-critical leaked through; got ' + e.payload?.severity);
    }
    console.log('OK events_recent severity_min filters and excludes events without severity');

    // 11p. watched_recent: signers see implicit subscriptions to their review areas.
    const watchedIss = await call('open_issue', {
        raised_by: 'qa-specialist', area: 'qa',
        title: 'watched: qa issue not owned by architect',
        assigned_to: 'backend-senior-dev', severity: 'medium'
    });
    const watchedId = watchedIss.result.structuredContent.issue_id;
    const raWatchSum = await call('state_summary', { agent: 'review-architect' });
    const raWatched = raWatchSum.result.structuredContent?.watched_recent;
    ASSERT(Array.isArray(raWatched),
        'state_summary(review-architect): watched_recent should be an array');
    ASSERT(raWatched.some(w => w.issue_id === watchedId),
        'watched_recent: review-architect should see ' + watchedId + '; got ' + JSON.stringify(raWatched.map(w=>w.issue_id)));
    const beWatchSum = await call('state_summary', { agent: 'backend-senior-dev' });
    ASSERT(!('watched_recent' in (beWatchSum.result.structuredContent || {})),
        'watched_recent: non-signer state_summary must omit the field entirely');
    console.log('OK watched_recent visible to signer only');

    // 12. parallel writes to events (single MCP server -> SQLite WAL): 50 logs across 5 agents in parallel
    const parallel = [];
    for (let i = 0; i < 10; i++) {
        for (const a of ['backend-senior-dev','frontend-senior-dev','qa-specialist','devops-engineer','tech-writer']) {
            parallel.push(call('log', { agent: a, summary: `parallel ${i} from ${a}` }));
        }
    }
    const results = await Promise.all(parallel);
    const failures = results.filter(r => r.result?.isError);
    ASSERT(failures.length === 0, `parallel writes had ${failures.length} errors`);
    console.log('OK 50 parallel writes: all succeeded');

    // 13. verify event count
    const recent = await call('events_recent', { limit: 200 });
    const evts = recent.result.structuredContent?.items || JSON.parse(recent.result.content[0].text);
    console.log('OK events_recent: total', evts.length, 'events');
    ASSERT(evts.length >= 50 + 1 + 1 + 1 + 1 + 1 + 1, 'expected at least 56 events');

    proc.kill();
    console.log('\n=== ALL SMOKE TESTS PASSED ===');
    process.exit(0);
})().catch(e => {
    console.error('test crashed:', e);
    proc.kill();
    process.exit(1);
});

setTimeout(() => { console.error('timeout'); proc.kill(); process.exit(2); }, 30000);
