#!/usr/bin/env node
/*!
 * Scheduled publication sync (runs in GitHub Actions, see
 * .github/workflows/sync-publications.yml). Checks ORCID + Semantic
 * Scholar against the publications already in index.html and, if it
 * finds anything, writes the proposed changes straight into index.html
 * for a pull request to review — it never pushes to main directly.
 *
 * This mirrors the matching/parsing/rendering logic behind the "Sync
 * publications" button in js/admin.js (same two sources, same
 * DOI-then-title matching, same byte-precise splice-in-place engine),
 * reimplemented standalone here because this runs in Node/CI rather than
 * a browser. If you change the matching or rendering rules in one place,
 * mirror the change in the other.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ORCID_ID = '0000-0002-8195-4118';
const ORCID_API_BASE = 'https://pub.orcid.org/v3.0';
// Pinned after verifying by hand which of several same-name Semantic Scholar
// author profiles is actually this person — see js/admin.js for the full story.
const SEMANTIC_SCHOLAR_AUTHOR_ID = '2075778349';
const SEMANTIC_SCHOLAR_API_BASE = 'https://api.semanticscholar.org/graph/v1';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_PATH = path.join(REPO_ROOT, 'index.html');

// ---------------------------------------------------------------------
// GitHub Actions output helper (no-op outside of Actions, e.g. local runs)
// ---------------------------------------------------------------------

function setOutput(name, value) {
    const filePath = process.env.GITHUB_OUTPUT;
    if (!filePath) return;
    const delimiter = `EOF_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

// ---------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------

function cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}

function normalizeTitle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractDoi(url) {
    const m = (url || '').match(/doi\.org\/(.+)$/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

// ---------------------------------------------------------------------
// HTML text engine — identical approach to js/admin.js's locate/splice
// ---------------------------------------------------------------------

function maskComments(html) {
    return html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
}

function findMatchingClose(maskedHtml, openIdx, tagName) {
    const openTok = `<${tagName}`;
    const closeTok = `</${tagName}>`;
    let depth = 0;
    let pos = openIdx;
    for (;;) {
        const nextOpen = maskedHtml.indexOf(openTok, pos);
        const nextClose = maskedHtml.indexOf(closeTok, pos);
        if (nextClose === -1) throw new Error(`Tag <${tagName}> not balanced (offset ${openIdx}).`);
        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth += 1;
            pos = nextOpen + openTok.length;
        } else {
            depth -= 1;
            pos = nextClose + closeTok.length;
            if (depth === 0) return pos;
        }
    }
}

function getElementRange(maskedHtml, startMarker, tagName) {
    const idx = maskedHtml.indexOf(startMarker);
    if (idx === -1) throw new Error(`Marker not found: ${startMarker}`);
    const end = findMatchingClose(maskedHtml, idx, tagName);
    return { start: idx, end };
}

function getSectionRange(maskedHtml, sectionId) {
    return getElementRange(maskedHtml, `<section class="resume-section" id="${sectionId}">`, 'section');
}

function listEntryBlocks(maskedHtml, sectionId) {
    const { start, end } = getSectionRange(maskedHtml, sectionId);
    const blocks = [];
    let pos = start;
    for (;;) {
        const idx = maskedHtml.indexOf('<div class="d-flex', pos);
        if (idx === -1 || idx >= end) break;
        const blockEnd = findMatchingClose(maskedHtml, idx, 'div');
        blocks.push({ start: idx, end: blockEnd });
        pos = blockEnd;
    }
    return blocks;
}

// Walks back from idx over spaces/tabs to the true start of the line (without
// crossing a newline) — needed anywhere a fresh render(), which already has its
// own leading indentation baked in, is spliced in next to a position like a
// block's `<div` that doesn't itself include the indentation before it. Splicing
// at the bare position would stack the old indentation and the new one; repeated
// runs would then compound it further with every commit.
function lineStart(html, idx) {
    let i = idx;
    while (i > 0 && (html[i - 1] === ' ' || html[i - 1] === '\t')) i -= 1;
    return i;
}

function getInsertionPoint(maskedHtml, sectionId) {
    const blocks = listEntryBlocks(maskedHtml, sectionId);
    if (blocks.length) return lineStart(maskedHtml, blocks[0].start);
    const { start, end } = getSectionRange(maskedHtml, sectionId);
    const h2Close = maskedHtml.indexOf('</h2>', start);
    const anchor = h2Close !== -1 && h2Close < end ? h2Close + 5 : start;
    const nl = maskedHtml.indexOf('\n', anchor);
    return nl !== -1 ? nl + 1 : anchor;
}

// ---------------------------------------------------------------------
// Publication block parse/render (same shape and template as admin.js)
// ---------------------------------------------------------------------

const { window: jsdomWindow } = new JSDOM('<!doctype html><html><body></body></html>');
const document = jsdomWindow.document;

function fragment(html) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    return wrapper;
}

function parsePublicationBlock(blockHtml) {
    const el = fragment(blockHtml).firstElementChild;
    const flexGrow = el.querySelector('.flex-grow-1');
    const kicker = cleanText((flexGrow.querySelector('h4') || {}).textContent);
    const h3 = flexGrow.querySelector('h3');
    const linkEl = h3.querySelector('a');
    const link = linkEl && linkEl.getAttribute('href') !== '#' ? linkEl.getAttribute('href') : '';
    const badgeEl = h3.querySelector('.badge');
    const badge = badgeEl ? cleanText(badgeEl.textContent) : '';
    const title = cleanText(linkEl ? linkEl.textContent : h3.textContent);
    const subEl = flexGrow.querySelector('.subheading');
    const subheading = cleanText(subEl ? subEl.textContent : '');
    const citationEl = subEl ? subEl.nextElementSibling : null;
    const citation = citationEl ? citationEl.innerHTML.trim() : '';
    const date = cleanText((el.querySelector('.flex-shrink-0') || {}).textContent);
    const compact = el.hasAttribute('data-compact');
    return { kicker, title, link, badge, subheading, date, citation, compact };
}

function renderPublicationBlock(d) {
    const compactAttr = d.compact ? ' data-compact="true"' : '';
    const href = escapeAttr(d.link || '#');
    const badgeHtml = d.badge
        ? `\n                                <span class="badge bg-secondary text-uppercase ms-2" style="font-size: 0.5em; vertical-align: middle;">${escapeHtml(d.badge)}</span>`
        : '';
    return `                    <div class="d-flex flex-column flex-md-row justify-content-between mb-5"${compactAttr}>
                        <div class="flex-grow-1">
                            <h4>${escapeHtml(d.kicker)}</h4>
                            <h3 class="mb-0">
                                <a href="${href}" target="_blank">
                                    ${escapeHtml(d.title)}
                                </a>${badgeHtml}
                            </h3>
                            <div class="subheading mb-3">${escapeHtml(d.subheading)}</div>
                            <div>
                                ${d.citation}
                            </div>
                        </div>
                        <div class="flex-shrink-0"><span class="text-primary">${escapeHtml(d.date)}</span></div>
                    </div>
`;
}

// ---------------------------------------------------------------------
// ORCID + Semantic Scholar clients (best-effort — a failure in one never
// blocks the other; Node 20's global fetch is used directly)
// ---------------------------------------------------------------------

const ORCID_TYPE_TO_KICKER = {
    'journal-article': 'Journal Article',
    'book-chapter': 'Conference Proceedings',
    'conference-paper': 'Conference Proceedings',
    'conference-abstract': 'Conference Proceedings',
    book: 'Book',
};

async function fetchOrcidWorks() {
    const res = await fetch(`${ORCID_API_BASE}/${ORCID_ID}/works`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ORCID error (${res.status}).`);
    const data = await res.json();
    const mapped = (data.group || []).map((g) => {
        const ws = g['work-summary'][0];
        const extIds = (ws['external-ids'] && ws['external-ids']['external-id']) || [];
        const doiEntry = extIds.find((e) => e['external-id-type'] === 'doi');
        const doi = doiEntry ? doiEntry['external-id-value'].toLowerCase() : null;
        const link = doiEntry
            ? (doiEntry['external-id-url'] && doiEntry['external-id-url'].value) || `https://doi.org/${doiEntry['external-id-value']}`
            : (ws.url && ws.url.value) || '';
        const year = ws['publication-date'] && ws['publication-date'].year ? ws['publication-date'].year.value : '';
        const title = ws.title && ws.title.title ? ws.title.title.value : '';
        const journal = ws['journal-title'] ? ws['journal-title'].value : '';
        return { doi, link, year, title, journal, kicker: ORCID_TYPE_TO_KICKER[ws.type] || 'Publication' };
    }).filter((w) => w.title);

    const byTitle = new Map();
    mapped.forEach((w) => {
        const key = normalizeTitle(w.title);
        const existing = byTitle.get(key);
        if (!existing || (!existing.doi && w.doi)) byTitle.set(key, w);
    });
    return Array.from(byTitle.values());
}

const S2_TYPE_TO_KICKER = {
    JournalArticle: 'Journal Article',
    Conference: 'Conference Proceedings',
    Review: 'Journal Article',
    Book: 'Book',
    BookSection: 'Conference Proceedings',
};

async function fetchSemanticScholarWorks() {
    const url = `${SEMANTIC_SCHOLAR_API_BASE}/author/${SEMANTIC_SCHOLAR_AUTHOR_ID}`
        + '?fields=papers.title,papers.year,papers.venue,papers.externalIds,papers.publicationTypes,papers.url';
    let res;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error('Could not reach Semantic Scholar (network error).');
    }
    if (res.status === 429) throw new Error('Semantic Scholar is rate-limited right now (shared global limit). Will try again next run.');
    if (!res.ok) throw new Error(`Semantic Scholar error (${res.status}).`);
    const data = await res.json();
    return (data.papers || []).map((p) => {
        const ext = p.externalIds || {};
        const doi = ext.DOI ? ext.DOI.toLowerCase() : null;
        const link = doi
            ? `https://doi.org/${ext.DOI}`
            : ext.ArXiv ? `https://arxiv.org/abs/${ext.ArXiv}` : (p.url || '');
        const types = p.publicationTypes || [];
        const kicker = types.map((t) => S2_TYPE_TO_KICKER[t]).find(Boolean) || 'Publication';
        return { doi, link, year: p.year ? String(p.year) : '', title: p.title || '', journal: p.venue || '', kicker };
    }).filter((w) => w.title);
}

function matchWorksAgainstSite(works, siteEntries) {
    const newOnes = [];
    const linkSuggestions = [];
    works.forEach((w) => {
        const normTitle = normalizeTitle(w.title);
        const match = siteEntries.find((s) => (w.doi && extractDoi(s.link) === w.doi) || normalizeTitle(s.title) === normTitle);
        if (!match) {
            newOnes.push(w);
        } else if (w.link && (!match.link || match.link === '#')) {
            linkSuggestions.push({ work: w, site: match });
        }
    });
    return { newOnes, linkSuggestions };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
    const content = fs.readFileSync(INDEX_PATH, 'utf8');
    const masked = maskComments(content);
    const blocks = listEntryBlocks(masked, 'pubs');
    const siteEntries = blocks.map((b, i) => ({ index: i, ...parsePublicationBlock(content.slice(b.start, b.end)) }));

    const sources = [];
    const failures = [];
    const [orcidResult, s2Result] = await Promise.allSettled([fetchOrcidWorks(), fetchSemanticScholarWorks()]);
    if (orcidResult.status === 'fulfilled') {
        sources.push({ name: 'ORCID', ...matchWorksAgainstSite(orcidResult.value, siteEntries) });
    } else {
        failures.push(`ORCID: ${orcidResult.reason.message}`);
    }
    if (s2Result.status === 'fulfilled') {
        sources.push({ name: 'Semantic Scholar', ...matchWorksAgainstSite(s2Result.value, siteEntries) });
    } else {
        failures.push(`Semantic Scholar: ${s2Result.reason.message}`);
    }

    const newOnes = [];
    const seenNew = new Set();
    sources.forEach((src) => {
        src.newOnes.forEach((w) => {
            const key = w.doi || normalizeTitle(w.title);
            if (seenNew.has(key)) return;
            seenNew.add(key);
            newOnes.push({ ...w, foundVia: src.name });
        });
    });

    const linkSuggestions = [];
    const seenLink = new Set();
    sources.forEach((src) => {
        src.linkSuggestions.forEach((s) => {
            if (seenLink.has(s.site.index)) return;
            seenLink.add(s.site.index);
            linkSuggestions.push({ ...s, foundVia: src.name });
        });
    });

    console.log(`Checked ${sources.map((s) => s.name).join(' and ') || 'no sources (all failed)'}; ${siteEntries.length} publications already on the site.`);
    failures.forEach((f) => console.log(`  (skipped) ${f}`));

    if (!newOnes.length && !linkSuggestions.length) {
        console.log('Nothing new to propose.');
        setOutput('has_changes', 'false');
        return;
    }

    let updated = content;
    const addedTitles = [];
    newOnes.forEach((w) => {
        const m = maskComments(updated);
        const insertAt = getInsertionPoint(m, 'pubs');
        // Unlike an edit, there's no existing gap to inherit here, so add one
        // blank line ourselves to match the spacing convention between entries.
        const rendered = renderPublicationBlock({
            kicker: w.kicker, title: w.title, link: w.link, badge: '',
            subheading: w.journal, date: w.year, citation: '', compact: false,
        }) + '\n';
        updated = updated.slice(0, insertAt) + rendered + updated.slice(insertAt);
        addedTitles.push(`${w.title} (via ${w.foundVia})`);
    });

    const linkedTitles = [];
    linkSuggestions.forEach((s) => {
        const m = maskComments(updated);
        const blocksNow = listEntryBlocks(m, 'pubs');
        // Every original site entry has shifted down by exactly newOnes.length,
        // since all new entries are always inserted at the top.
        const adjustedIndex = s.site.index + newOnes.length;
        const b = blocksNow[adjustedIndex];
        if (!b) return;
        const newData = { ...s.site, link: s.work.link };
        const spliceStart = lineStart(updated, b.start);
        // The untouched text after b.end already carries the original blank-line
        // separator before the next entry — drop the template's own trailing
        // newline so it isn't doubled on top of that.
        const rendered = renderPublicationBlock(newData).replace(/\n$/, '');
        updated = updated.slice(0, spliceStart) + rendered + updated.slice(b.end);
        linkedTitles.push(`${s.site.title} (via ${s.foundVia})`);
    });

    fs.writeFileSync(INDEX_PATH, updated, 'utf8');

    const summaryLines = [];
    if (addedTitles.length) {
        summaryLines.push(`### New publications added (${addedTitles.length})`, ...addedTitles.map((t) => `- ${t}`), '');
    }
    if (linkedTitles.length) {
        summaryLines.push(`### Missing links filled in (${linkedTitles.length})`, ...linkedTitles.map((t) => `- ${t}`), '');
    }
    if (failures.length) {
        summaryLines.push('### Sources that could not be checked this run', ...failures.map((f) => `- ${f}`), '');
    }
    summaryLines.push('_Please review each entry — especially the venue, type and citation text — before merging. This data comes from ORCID/Semantic Scholar and is not as carefully curated as the rest of the site; nothing has been auto-merged._');

    const summary = summaryLines.join('\n');
    console.log('\n' + summary);
    setOutput('has_changes', 'true');
    setOutput('summary', summary);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
