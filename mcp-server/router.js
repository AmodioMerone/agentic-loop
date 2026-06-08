// router.js — deterministic, zero-LLM task routing based on capability cards.
//
// The scorer is intentionally simple: lexical overlap between a tokenized
// task description and the union of an agent's `capabilities`, `areas`,
// and `summary` tokens. `hints.area` and `hints.files` boost matching
// cards. No model calls, ~O(cards * tokens) per route_task — fast enough
// to be called inline.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STOP_WORDS = new Set([
    'the','a','an','to','of','in','on','for','and','or','with','my'
]);

// Cache so we don't re-read & re-parse cards on every call. Keyed by dir
// because in practice the server only ever passes one path, but we don't
// want surprise sharing across tests that point to different dirs.
const cardCache = new Map();

export function loadCards(cardsDir) {
    const cached = cardCache.get(cardsDir);
    if (cached) return cached;
    const entries = readdirSync(cardsDir).filter(f => f.endsWith('.json'));
    const cards = entries.map(f => {
        const raw = JSON.parse(readFileSync(join(cardsDir, f), 'utf8'));
        return {
            name: raw.name,
            capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
            areas: Array.isArray(raw.areas) ? raw.areas : [],
            summary: raw.summary || '',
            model_hint: raw.model_hint || null,
            routes_to: Array.isArray(raw.routes_to) ? raw.routes_to : []
        };
    });
    cardCache.set(cardsDir, cards);
    return cards;
}

export function tokenize(text) {
    if (!text) return new Set();
    const toks = String(text).toLowerCase().split(/[^a-z0-9]+/);
    const out = new Set();
    for (const t of toks) {
        if (!t) continue;
        if (STOP_WORDS.has(t)) continue;
        out.add(t);
    }
    return out;
}

// Each pattern is matched against the lower-cased file path. Multiple
// patterns can fire on the same file (e.g. "app/components/Button.test.tsx"
// hits both frontend and qa).
const FILE_HINTS = [
    { agent: 'backend-senior-dev',  test: (p) =>
        /(^|\/)(server|api|db|migrations)\//.test(p) || /\.sql$/.test(p) },
    { agent: 'frontend-senior-dev', test: (p) =>
        /\.(tsx|jsx)$/.test(p) || /(^|\/)(app|web|components)\//.test(p) },
    { agent: 'devops-engineer',     test: (p) =>
        /(^|\/)dockerfile$/i.test(p) || /\.tf$/.test(p) ||
        /(^|\/)\.github\/workflows\//.test(p) || /(^|\/)k8s\//.test(p) },
    { agent: 'qa-specialist',       test: (p) =>
        /\.(test|spec)\.[a-z0-9]+$/.test(p) || /(^|\/)__tests__\//.test(p) },
    { agent: 'tech-writer',         test: (p) => {
        if (/(^|\/)docs\//.test(p)) return true;
        if (/(^|\/)changelog(\.[a-z0-9]+)?$/.test(p)) return true;
        if (/(^|\/)adr-[^/]+$/.test(p)) return true;
        if (/\.md$/.test(p) && !/(^|\/)readme\.md$/.test(p)) return true;
        return false;
    }}
];

function scoreCard(card, taskTokens, hints) {
    // Build the card's token bag once per scoreTask call. We add both the
    // raw capability/area strings AND their tokenized sub-parts so that a
    // compound capability like "secrets-audit" matches a task token "secret"
    // (via the tokenizer's stem-ish split) as well as a literal lookup of
    // "secrets-audit".
    const bag = new Set();
    for (const c of card.capabilities) {
        const lc = String(c).toLowerCase();
        bag.add(lc);
        for (const t of tokenize(lc)) bag.add(t);
    }
    for (const a of card.areas) {
        const lc = String(a).toLowerCase();
        bag.add(lc);
        for (const t of tokenize(lc)) bag.add(t);
    }
    for (const t of tokenize(card.summary)) bag.add(t);

    let score = 0;
    const matched = [];
    for (const tok of taskTokens) {
        if (bag.has(tok)) { score++; matched.push(tok); }
    }
    let areaHit = false;
    if (hints && hints.area && card.areas.includes(hints.area)) {
        score += 50;
        areaHit = true;
    }
    let fileHits = 0;
    if (hints && Array.isArray(hints.files) && hints.files.length) {
        for (const f of hints.files) {
            const p = String(f).toLowerCase();
            for (const rule of FILE_HINTS) {
                if (rule.agent !== card.name) continue;
                if (rule.test(p)) { score += 10; fileHits++; break; }
            }
        }
    }
    return { score, matched, areaHit, fileHits };
}

export function scoreTask(task, hints, cards) {
    const taskTokens = tokenize(task);
    const scored = cards.map(card => {
        const s = scoreCard(card, taskTokens, hints);
        return { card, ...s };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const parts = [];
    if (best.matched.length) {
        parts.push(`matched on tokens [${best.matched.join(', ')}]`);
    } else {
        parts.push('no token overlap');
    }
    if (best.areaHit) parts.push(`area hint '${hints.area}'`);
    if (best.fileHits) parts.push('file hints aligned');
    return {
        recommended_agent: best.card.name,
        score: best.score,
        runners_up: scored.slice(1, 3).map(s => ({ name: s.card.name, score: s.score })),
        rationale: parts.join('; ')
    };
}
