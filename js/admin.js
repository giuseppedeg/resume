/*!
 * Resume admin editor.
 *
 * Lets the site owner add/edit/delete entries directly on GitHub, using a
 * personal access token entered in the browser (kept only in sessionStorage).
 * It fetches index.html from the GitHub Contents API, locates the exact
 * source range of the entry being touched with a small balanced-tag scanner
 * (not regex — nested <div>s aren't regex-safe), splices in freshly rendered
 * markup for just that one entry, and commits the result back. Every other
 * entry's original HTML is left completely untouched.
 */
(function () {
    'use strict';

    const OWNER = 'giuseppedeg';
    const REPO = 'resume';
    const BRANCH = 'main';
    const FILE_PATH = 'index.html';
    const API_BASE = 'https://api.github.com';
    const TOKEN_KEY = 'resume_admin_token';
    const ORCID_ID = '0000-0002-8195-4118';
    const ORCID_API_BASE = 'https://pub.orcid.org/v3.0';
    // Semantic Scholar's author-name search returns many same-name candidates (checked:
    // a 77-paper profile under this name turns out to merge a Byzantine-manuscripts
    // scholar, a biochemist and this Giuseppe under one disambiguation-failed ID) — so
    // this is pinned to the one profile independently verified by matching its papers'
    // DOIs against the known ORCID/site publications, rather than searched at runtime.
    const SEMANTIC_SCHOLAR_AUTHOR_ID = '2075778349';
    const SEMANTIC_SCHOLAR_API_BASE = 'https://api.semanticscholar.org/graph/v1';
    // Runs the Google Scholar check (via SerpApi, server-side — see
    // .github/scripts/sync-publications.js) since a Scholar-scraping API key
    // can't safely live in this browser-side code. The button below just
    // triggers the existing scheduled workflow on demand and opens a PR;
    // nothing publishes without review, same as every other sync source.
    const SYNC_WORKFLOW_FILE = 'sync-publications.yml';

    // -----------------------------------------------------------------
    // Text helpers
    // -----------------------------------------------------------------

    function cleanText(str) {
        return (str || '').replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(str) {
        return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escapeAttr(str) {
        return escapeHtml(str).replace(/"/g, '&quot;');
    }

    // -----------------------------------------------------------------
    // Base64 <-> UTF-8 (plain atob/btoa corrupts accented characters)
    // -----------------------------------------------------------------

    function utf8ToBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        bytes.forEach((b) => { binary += String.fromCharCode(b); });
        return btoa(binary);
    }

    function base64ToUtf8(b64) {
        const binary = atob(b64.replace(/\n/g, ''));
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    // -----------------------------------------------------------------
    // GitHub client
    // -----------------------------------------------------------------

    const Github = {
        token: null,

        async request(path, options) {
            const res = await fetch(`${API_BASE}${path}`, {
                ...options,
                headers: {
                    Authorization: `token ${this.token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(options && options.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(options && options.headers),
                },
            });
            return res;
        },

        async validateToken() {
            const res = await this.request(`/repos/${OWNER}/${REPO}`, {});
            if (!res.ok) {
                if (res.status === 401) throw new Error('Invalid or expired token.');
                if (res.status === 404) throw new Error('Repository not found, or the token has no access to it.');
                throw new Error(`GitHub error (${res.status}).`);
            }
            const data = await res.json();
            if (!data.permissions || !data.permissions.push) {
                throw new Error('This token does not have write access to the repository.');
            }
            return data;
        },

        async fetchFile(path) {
            const res = await this.request(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {});
            if (!res.ok) throw new Error(`Could not read ${path} (${res.status}).`);
            const data = await res.json();
            return { content: base64ToUtf8(data.content), sha: data.sha };
        },

        async saveFile(path, content, sha, message) {
            const res = await this.request(`/repos/${OWNER}/${REPO}/contents/${path}`, {
                method: 'PUT',
                body: JSON.stringify({ message, content: utf8ToBase64(content), sha, branch: BRANCH }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                if (res.status === 409) {
                    const err = new Error('The file changed since you last loaded it. Reload and try again.');
                    err.isConflict = true;
                    throw err;
                }
                throw new Error(body.message || `GitHub error (${res.status}).`);
            }
            return res.json();
        },

        // Metadata only (sha + download URL), without decoding content as UTF-8 text —
        // needed for binary files like images, where that decode would corrupt the data.
        async getFileMeta(path) {
            const res = await this.request(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {});
            if (res.status === 404) return { sha: null, exists: false, downloadUrl: null };
            if (!res.ok) throw new Error(`Could not read ${path} (${res.status}).`);
            const data = await res.json();
            return { sha: data.sha, exists: true, downloadUrl: data.download_url };
        },

        async saveBinaryFile(path, base64Content, sha, message) {
            const body = { message, content: base64Content, branch: BRANCH };
            if (sha) body.sha = sha;
            const res = await this.request(`/repos/${OWNER}/${REPO}/contents/${path}`, {
                method: 'PUT',
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                if (res.status === 409) throw new Error('The file changed since you last loaded it. Reload and try again.');
                throw new Error(errBody.message || `GitHub error (${res.status}).`);
            }
            return res.json();
        },

        // Triggers a workflow_dispatch run (returns no body on success). Needs the
        // token to have "Actions: Read and write" in addition to Contents — if it
        // doesn't, GitHub returns 404 here (not 403), since a token with no Actions
        // access can't even see that the workflow exists.
        async dispatchWorkflow(workflowFile) {
            const res = await this.request(`/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/dispatches`, {
                method: 'POST',
                body: JSON.stringify({ ref: BRANCH }),
            });
            if (!res.ok) {
                if (res.status === 404) {
                    throw new Error('Could not start the workflow (404). Your token likely needs "Actions: Read and write" permission added.');
                }
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || `GitHub error (${res.status}).`);
            }
        },
    };

    // -----------------------------------------------------------------
    // ORCID sync (read-only, public API — no token needed).
    //
    // ORCID's own metadata is noisier than the hand-curated site content
    // (duplicate records from different sources, generic type labels like
    // "book-chapter" instead of "Conference Proceedings", no formatted
    // citation text) — so this never overwrites an existing entry's title,
    // kicker or citation. It only (a) surfaces ORCID works that don't match
    // anything on the site yet, pre-filling the normal Add form for review,
    // and (b) offers to fill in a missing DOI link on an entry that already
    // matches by title. Nothing is ever published without going through the
    // same form + explicit submit as a manual add/edit.
    // -----------------------------------------------------------------

    const ORCID_TYPE_TO_KICKER = {
        'journal-article': 'Journal Article',
        'book-chapter': 'Conference Proceedings',
        'conference-paper': 'Conference Proceedings',
        'conference-abstract': 'Conference Proceedings',
        book: 'Book',
    };

    function normalizeTitle(title) {
        return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function extractDoi(url) {
        const m = (url || '').match(/doi\.org\/(.+)$/i);
        return m ? decodeURIComponent(m[1]).toLowerCase() : null;
    }

    async function fetchOrcidWorks() {
        const res = await fetch(`${ORCID_API_BASE}/${ORCID_ID}/works`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Could not reach ORCID (${res.status}).`);
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

        // ORCID itself can list the same paper twice (e.g. one record auto-imported
        // from Crossref, one added by hand) — collapse by normalized title, keeping
        // whichever copy has a DOI.
        const byTitle = new Map();
        mapped.forEach((w) => {
            const key = normalizeTitle(w.title);
            const existing = byTitle.get(key);
            if (!existing || (!existing.doi && w.doi)) byTitle.set(key, w);
        });
        return Array.from(byTitle.values());
    }

    // -----------------------------------------------------------------
    // Semantic Scholar sync (public API, read-only — no token needed).
    //
    // Unlike ORCID, Semantic Scholar's unauthenticated tier shares a global
    // rate-limit pool across every anonymous caller worldwide, so a 429 here
    // is expected sometimes and isn't a bug — this is explicitly best-effort:
    // when it works it's a bonus (it already surfaced an arXiv preprint link
    // ORCID didn't have), when it doesn't the button just shows a friendly
    // "try again" message and nothing else in the admin tool is affected.
    // -----------------------------------------------------------------

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
        if (res.status === 429) throw new Error('Semantic Scholar is rate-limited right now (it shares one global limit across every anonymous user). Try again in a bit.');
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

    // -----------------------------------------------------------------
    // Combined sync: fetches both sources in parallel via allSettled (one
    // being rate-limited or down never blocks the other), matches each
    // against the site, and merges the results into one review list —
    // deduping a work that both sources independently flag so it's never
    // shown twice. ORCID is treated as primary when both sources have the
    // same work (its type/kicker classification was more accurate than
    // Semantic Scholar's in testing), Semantic Scholar fills in the rest.
    // -----------------------------------------------------------------

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

    async function syncPublicationSources() {
        const { content } = await loadFile();
        const masked = maskComments(content);
        const blocks = listEntryBlocks(masked, 'pubs');
        const siteEntries = blocks.map((b, i) => ({ index: i, ...parsePublicationBlock(content.slice(b.start, b.end)) }));

        const [orcidResult, s2Result] = await Promise.allSettled([fetchOrcidWorks(), fetchSemanticScholarWorks()]);
        const sources = [];
        const failures = [];
        if (orcidResult.status === 'fulfilled') {
            sources.push({ name: 'ORCID', total: orcidResult.value.length, ...matchWorksAgainstSite(orcidResult.value, siteEntries) });
        } else {
            failures.push({ name: 'ORCID', message: orcidResult.reason.message });
        }
        if (s2Result.status === 'fulfilled') {
            sources.push({ name: 'Semantic Scholar', total: s2Result.value.length, ...matchWorksAgainstSite(s2Result.value, siteEntries) });
        } else {
            failures.push({ name: 'Semantic Scholar', message: s2Result.reason.message });
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

        return { newOnes, linkSuggestions, sources, failures, totalSite: siteEntries.length };
    }

    // -----------------------------------------------------------------
    // Coverage check: publications with no matching Conferences and Seminars
    // entry. There's no external API for "talks I gave" (checked ORCID's
    // invited-positions/distinctions/services sections for this profile —
    // all empty), so this only cross-references the site's own two
    // sections. Matching is fuzzy (shared year + a shared distinctive
    // capitalized word/acronym between the publication's venue text and a
    // conference entry's title) — it's a prompt to review, not a reliable
    // fact, so false positives (e.g. a journal article from the same year
    // as an unrelated conference) are expected and fine: nothing is ever
    // auto-applied, every suggestion opens a normal, empty-ish form.
    // -----------------------------------------------------------------

    const GENERIC_CAPITALIZED_WORDS = new Set(['the', 'a', 'an', 'international', 'conference', 'conferences',
        'workshop', 'workshops', 'proceedings', 'society', 'symposium', 'annual', 'seminar',
        'application', 'applications', 'association', 'journal', 'of', 'on', 'for', 'and', 'in', 'st', 'nd', 'rd', 'th']);

    function extractYears(text) {
        return new Set((text || '').match(/(19|20)\d{2}/g) || []);
    }

    function extractDistinctiveWords(text) {
        const words = (text || '').match(/[A-Za-z][A-Za-z0-9]*/g) || [];
        return new Set(
            words
                .filter((w) => /^[A-Z]/.test(w) && w.length >= 3 && !GENERIC_CAPITALIZED_WORDS.has(w.toLowerCase()))
                .map((w) => w.toLowerCase())
        );
    }

    function venueSignature(text) {
        return { years: extractYears(text), words: extractDistinctiveWords(text) };
    }

    function venuesLikelyMatch(a, b) {
        const sharedYear = [...a.years].some((y) => b.years.has(y));
        const sharedWord = [...a.words].some((w) => b.words.has(w));
        return sharedYear && sharedWord;
    }

    async function findPublicationsWithoutConfEntry() {
        const { content } = await loadFile();
        const masked = maskComments(content);
        const pubs = listEntryBlocks(masked, 'pubs').map((b) => parsePublicationBlock(content.slice(b.start, b.end)));
        const confs = listEntryBlocks(masked, 'confs').map((b) => parseConfsBlock(content.slice(b.start, b.end)));
        const confSignatures = confs.map((c) => venueSignature(c.title));

        const unmatched = pubs.filter((p) => {
            const sig = venueSignature(`${p.subheading} ${p.citation} ${p.date}`);
            return !confSignatures.some((cs) => venuesLikelyMatch(sig, cs));
        });
        return { unmatched, totalPubs: pubs.length, totalConfs: confs.length };
    }

    // -----------------------------------------------------------------
    // HTML text engine: locate exact source ranges without a full parser
    // -----------------------------------------------------------------

    // Blanks out <!-- ... --> comments (same length, so offsets stay valid)
    // so a commented-out example block never gets mistaken for real markup.
    function maskComments(html) {
        return html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    }

    // Given the index of an opening `<tagName`, returns the offset right
    // after the matching `</tagName>`, counting nested same-tag pairs.
    function findMatchingClose(maskedHtml, openIdx, tagName) {
        const openTok = `<${tagName}`;
        const closeTok = `</${tagName}>`;
        let depth = 0;
        let pos = openIdx;
        for (;;) {
            const nextOpen = maskedHtml.indexOf(openTok, pos);
            const nextClose = maskedHtml.indexOf(closeTok, pos);
            if (nextClose === -1) throw new Error(`Tag <${tagName}> non bilanciato (offset ${openIdx}).`);
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
        if (idx === -1) throw new Error(`Marcatore non trovato: ${startMarker}`);
        const end = findMatchingClose(maskedHtml, idx, tagName);
        return { start: idx, end };
    }

    function getSectionRange(maskedHtml, sectionId) {
        return getElementRange(maskedHtml, `<section class="resume-section" id="${sectionId}">`, 'section');
    }

    // Lists every top-level `<openNeedle ...>...</tagName>` sibling inside [start,end).
    function listTagBlocksIn(maskedHtml, start, end, openNeedle, tagName) {
        const blocks = [];
        let pos = start;
        for (;;) {
            const idx = maskedHtml.indexOf(openNeedle, pos);
            if (idx === -1 || idx >= end) break;
            const blockEnd = findMatchingClose(maskedHtml, idx, tagName);
            blocks.push({ start: idx, end: blockEnd });
            pos = blockEnd;
        }
        return blocks;
    }

    function listEntryBlocks(maskedHtml, sectionId) {
        const { start, end } = getSectionRange(maskedHtml, sectionId);
        return listTagBlocksIn(maskedHtml, start, end, '<div class="d-flex', 'div');
    }

    // Walks back from idx over spaces/tabs to the true start of the line (without
    // crossing a newline) — needed anywhere a fresh render(), which already has its
    // own leading indentation baked in, is spliced in next to a position like a
    // block's `<div` that doesn't itself include the indentation before it. Splicing
    // at the bare position would stack the old indentation and the new one; repeated
    // edits would then compound it further with every save.
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

    // Replaces the inner HTML of the first element matching `startMarker`/`tagName`.
    function replaceInner(content, startMarker, tagName, newInner) {
        const masked = maskComments(content);
        const idx = masked.indexOf(startMarker);
        if (idx === -1) throw new Error(`Marcatore non trovato: ${startMarker}`);
        const end = findMatchingClose(masked, idx, tagName);
        const closeTok = `</${tagName}>`;
        const innerStart = idx + startMarker.length;
        const innerEnd = end - closeTok.length;
        return content.slice(0, innerStart) + newInner + content.slice(innerEnd);
    }

    // -----------------------------------------------------------------
    // Parsing: raw HTML fragment -> plain field values (uses the browser's
    // own HTML parser for correctness, same approach as js/cv-pdf.js)
    // -----------------------------------------------------------------

    function fragment(html) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        return wrapper;
    }

    function parseExperienceBlock(blockHtml) {
        const el = fragment(blockHtml).firstElementChild;
        const flexGrow = el.querySelector('.flex-grow-1');
        const title = cleanText(flexGrow.querySelector('h3').textContent);
        const subheading = cleanText((flexGrow.querySelector('.subheading') || {}).textContent);
        const date = cleanText((el.querySelector('.flex-shrink-0') || {}).textContent);
        const intro = Array.from(flexGrow.querySelectorAll('p')).map((p) => p.innerHTML.trim()).filter(Boolean);
        const bullets = Array.from(flexGrow.querySelectorAll('li')).map((li) => li.innerHTML.trim());
        const compact = el.hasAttribute('data-compact');
        return { title, subheading, date, intro, bullets, compact };
    }

    function renderExperienceBlock(d) {
        const compactAttr = d.compact ? ' data-compact="true"' : '';
        const intro = (d.intro || []).filter(Boolean).map((p) => `                            <p>${p}</p>\n`).join('');
        const bullets = (d.bullets || []).filter(Boolean);
        const bulletsHtml = bullets.length
            ? `                            <ul>\n${bullets.map((b) => `                                <li>${b}</li>\n`).join('')}                            </ul>\n`
            : '';
        return `                    <div class="d-flex flex-column flex-md-row justify-content-between mb-5"${compactAttr}>
                        <div class="flex-grow-1">
                            <h3 class="mb-0">${escapeHtml(d.title)}</h3>
                            <div class="subheading mb-3">${escapeHtml(d.subheading)}</div>
${intro}${bulletsHtml}                        </div>
                        <div class="flex-shrink-0"><span class="text-primary">${escapeHtml(d.date)}</span></div>
                    </div>
`;
    }

    function parseEducationBlock(blockHtml) {
        const el = fragment(blockHtml).firstElementChild;
        const flexGrow = el.querySelector('.flex-grow-1');
        const h3 = flexGrow.querySelector('h3');
        const title = cleanText(h3.textContent);
        const subheading = cleanText((flexGrow.querySelector('.subheading') || {}).textContent);
        const date = cleanText((el.querySelector('.flex-shrink-0') || {}).textContent);
        const lines = [];
        Array.from(flexGrow.children).forEach((child) => {
            if (child === h3) return;
            if (child.classList && child.classList.contains('subheading')) return;
            const t = cleanText(child.textContent);
            if (t) lines.push(t);
        });
        const compact = el.hasAttribute('data-compact');
        return { title, subheading, date, lines, compact };
    }

    function renderEducationBlock(d) {
        const compactAttr = d.compact ? ' data-compact="true"' : '';
        const lines = (d.lines || []).filter(Boolean).map((l) => `                            <div>${l}</div>\n`).join('');
        return `                    <div class="d-flex flex-column flex-md-row justify-content-between mb-5"${compactAttr}>
                        <div class="flex-grow-1">
                            <h3 class="mb-0">${escapeHtml(d.title)}</h3>
                            <div class="subheading mb-3">${escapeHtml(d.subheading)}</div>
${lines}                        </div>
                        <div class="flex-shrink-0"><span class="text-primary">${escapeHtml(d.date)}</span></div>
                    </div>
`;
    }

    function parseAbroadBlock(blockHtml) {
        const el = fragment(blockHtml).firstElementChild;
        const flexGrow = el.querySelector('.flex-grow-1');
        const title = cleanText(flexGrow.querySelector('h3').textContent);
        const h4 = flexGrow.querySelector('h4');
        const institution = cleanText(h4 ? h4.textContent : '');
        const date = cleanText((el.querySelector('.flex-shrink-0') || {}).textContent);
        const descEl = h4 ? h4.nextElementSibling : null;
        const description = descEl ? descEl.innerHTML.trim() : '';
        return { title, institution, date, description };
    }

    function renderAbroadBlock(d) {
        return `                    <div class="d-flex flex-column flex-md-row justify-content-between mb-5">
                        <div class="flex-grow-1">
                            <h3 class="mb-0">${escapeHtml(d.title)}</h3>
                            <h4 class="mb-0">${escapeHtml(d.institution)}</h4>
                            <div>
                                ${d.description}
                            </div>
                        </div>
                        <div class="flex-shrink-0"><span class="text-primary">${escapeHtml(d.date)}</span></div>
                    </div>
`;
    }

    const INVITED_RE = /^\s*<b>\s*Invited Speaker\s*<\/b>\s*<br\s*\/?>\s*/i;

    function parseConfsBlock(blockHtml) {
        const el = fragment(blockHtml).firstElementChild;
        const flexGrow = el.querySelector('.flex-grow-1');
        const h3 = flexGrow.querySelector('h3');
        const linkEl = h3.querySelector('a');
        const title = cleanText(h3.textContent);
        const link = linkEl && linkEl.getAttribute('href') !== '#' ? linkEl.getAttribute('href') : '';
        const subEl = flexGrow.querySelector('.subheading');
        const subheading = cleanText(subEl ? subEl.textContent : '');
        const descEl = subEl ? subEl.nextElementSibling : null;
        let description = descEl ? descEl.innerHTML.trim() : '';
        const invitedSpeaker = INVITED_RE.test(description);
        if (invitedSpeaker) description = description.replace(INVITED_RE, '').trim();
        const date = cleanText((el.querySelector('.flex-shrink-0') || {}).textContent);
        return { title, link, subheading, date, invitedSpeaker, description };
    }

    function renderConfsBlock(d) {
        const invitedPrefix = d.invitedSpeaker ? '<b>Invited Speaker</b><br />\n                                ' : '';
        const href = escapeAttr(d.link || '#');
        return `                    <div class="d-flex flex-column flex-md-row justify-content-between mb-5">
                        <div class="flex-grow-1">
                            <h3 class="mb-0"><a href="${href}" target="_blank">
                                ${escapeHtml(d.title)}
                            </a></h3>
                            <div class="subheading mb-3">${escapeHtml(d.subheading)}</div>
                            <div>
                                ${invitedPrefix}${d.description}
                            </div>
                        </div>
                        <div class="flex-shrink-0"><span class="text-primary">${escapeHtml(d.date)}</span></div>
                    </div>
`;
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

    // -----------------------------------------------------------------
    // BibTeX import (Publications "New entry" form only) — a convenience for
    // pre-filling the form from a pasted BibTeX entry. The result is always
    // just a draft left in the normal, editable form fields: nothing is
    // saved until the admin reviews it and explicitly submits, same as the
    // ORCID/Semantic Scholar sync suggestions above.
    // -----------------------------------------------------------------

    const LATEX_ACCENT_MARKS = {
        "'": '́', '`': '̀', '"': '̈', '^': '̂', '~': '̃',
        '=': '̄', '.': '̇', v: '̌', u: '̆', H: '̋',
    };
    const LATEX_SYMBOLS = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', l: 'ł', L: 'Ł' };

    function decodeLatexAccents(str) {
        if (!str) return str;
        let out = str;
        out = out.replace(/\\([`'^"~=.]|[vuH])\{([a-zA-Z])\}/g, (_, cmd, letter) => (letter + (LATEX_ACCENT_MARKS[cmd] || '')).normalize('NFC'));
        out = out.replace(/\\([`'^"~=.]|[vuH])([a-zA-Z])/g, (_, cmd, letter) => (letter + (LATEX_ACCENT_MARKS[cmd] || '')).normalize('NFC'));
        out = out.replace(/\\c\{([a-zA-Z])\}/g, (_, letter) => (letter + '̧').normalize('NFC'));
        out = out.replace(/\\(ss|o|O|ae|AE|l|L)(?![a-zA-Z])/g, (_, cmd) => LATEX_SYMBOLS[cmd] || cmd);
        out = out.replace(/--/g, '–').replace(/~/g, ' ');
        return out;
    }

    function cleanBibtexValue(v) {
        return decodeLatexAccents(v || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    }

    function findMatchingBrace(text, openIdx) {
        let depth = 0;
        for (let i = openIdx; i < text.length; i += 1) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') {
                depth -= 1;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function parseBibtexFieldBody(body) {
        const fields = {};
        let i = 0;
        while (i < body.length) {
            while (i < body.length && /[\s,]/.test(body[i])) i += 1;
            if (i >= body.length) break;
            const keyMatch = /^[A-Za-z][A-Za-z0-9_-]*/.exec(body.slice(i));
            if (!keyMatch) break;
            const key = keyMatch[0].toLowerCase();
            i += keyMatch[0].length;
            while (i < body.length && /\s/.test(body[i])) i += 1;
            if (body[i] !== '=') break;
            i += 1;
            while (i < body.length && /\s/.test(body[i])) i += 1;
            let value = '';
            if (body[i] === '{') {
                const close = findMatchingBrace(body, i);
                if (close === -1) break;
                value = body.slice(i + 1, close);
                i = close + 1;
            } else if (body[i] === '"') {
                let j = i + 1;
                while (j < body.length && body[j] !== '"') j += 1;
                value = body.slice(i + 1, j);
                i = j + 1;
            } else {
                let j = i;
                while (j < body.length && body[j] !== ',' && body[j] !== '\n') j += 1;
                value = body.slice(i, j).trim();
                i = j;
            }
            fields[key] = cleanBibtexValue(value);
        }
        return fields;
    }

    function parseBibtexEntry(text) {
        const m = /@\s*([A-Za-z]+)\s*\{/.exec(text || '');
        if (!m) throw new Error('No BibTeX entry found (expected something like "@inproceedings{...").');
        const type = m[1].toLowerCase();
        const braceStart = text.indexOf('{', m.index);
        const braceEnd = findMatchingBrace(text, braceStart);
        if (braceEnd === -1) throw new Error('Unbalanced braces in the BibTeX entry.');
        const inner = text.slice(braceStart + 1, braceEnd);
        const commaIdx = inner.indexOf(',');
        const fields = parseBibtexFieldBody(commaIdx === -1 ? '' : inner.slice(commaIdx + 1));
        return { type, fields };
    }

    const BIBTEX_TYPE_TO_KICKER = {
        article: 'Journal Article',
        inproceedings: 'Conference Proceedings',
        conference: 'Conference Proceedings',
        incollection: 'Book Chapter',
        inbook: 'Book Chapter',
        book: 'Book',
        phdthesis: 'PhD Thesis',
        mastersthesis: "Master's Thesis",
        techreport: 'Technical Report',
    };

    // Renders as "Last, F." (matching the site's existing citation style), bolding
    // whichever author is Giuseppe himself — also matching existing entries, which
    // all bold his own name in the author list.
    function formatBibtexAuthor(name) {
        const cleaned = cleanBibtexValue(name);
        let last;
        let first;
        if (cleaned.includes(',')) {
            [last, first] = cleaned.split(',').map((s) => s.trim());
        } else {
            const parts = cleaned.split(/\s+/);
            last = parts.pop();
            first = parts.join(' ');
        }
        const initial = first ? `${first.trim()[0]}.` : '';
        const formatted = initial ? `${last}, ${initial}` : last;
        const isSelf = last.toLowerCase().replace(/[^a-z]/g, '').includes('degregorio');
        return isSelf ? `<strong>${formatted}</strong>` : formatted;
    }

    function bibtexToPublicationFields(text) {
        const { type, fields } = parseBibtexEntry(text);
        if (!fields.title) throw new Error('This BibTeX entry has no "title" field.');

        const venue = fields.journal || fields.booktitle || fields.publisher || fields.organization || fields.school || '';
        const doi = fields.doi ? fields.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : '';
        const isArxiv = fields.eprint && /arxiv/i.test(fields.archiveprefix || '');
        const link = doi ? `https://doi.org/${doi}` : fields.url ? fields.url : isArxiv ? `https://arxiv.org/abs/${fields.eprint}` : '';
        const kicker = BIBTEX_TYPE_TO_KICKER[type] || (isArxiv ? 'Preprint' : '');

        const authors = (fields.author || '').split(/\s+and\s+/i).filter(Boolean).map(formatBibtexAuthor);
        const authorsStr = authors.join(', ');
        const authorsSep = authorsStr.replace(/<\/strong>$/, '').endsWith('.') ? '' : '.';
        const citation = authorsStr ? `${authorsStr}${authorsSep} ${fields.title}${venue ? `. In: *${venue}*` : ''}.` : '';

        return { kicker, title: fields.title, link, subheading: venue, date: fields.year || '', citation };
    }

    // -----------------------------------------------------------------
    // Section registry
    // -----------------------------------------------------------------

    const SECTIONS = {
        experience: {
            label: 'Experience',
            parse: parseExperienceBlock,
            render: renderExperienceBlock,
            fields: [
                { key: 'title', label: 'Role', type: 'text', required: true },
                { key: 'subheading', label: 'Institution / Organization', type: 'text', required: true },
                { key: 'date', label: 'Period (e.g. "January 2022 - June 2022")', type: 'text', required: true },
                { key: 'intro', label: 'Intro text (one line per paragraph — basic HTML allowed, e.g. <a href="...">link</a>)', type: 'lines' },
                { key: 'bullets', label: 'Bullet points (one per line — basic HTML allowed)', type: 'lines' },
                { key: 'compact', label: 'Include in Compact CV', type: 'checkbox' },
            ],
        },
        education: {
            label: 'Education',
            parse: parseEducationBlock,
            render: renderEducationBlock,
            fields: [
                { key: 'title', label: 'Degree', type: 'text', required: true },
                { key: 'subheading', label: 'Institution', type: 'text', required: true },
                { key: 'date', label: 'Period', type: 'text', required: true },
                { key: 'lines', label: 'Details (one line per item: field, thesis title, grade, etc.)', type: 'lines' },
                { key: 'compact', label: 'Include in Compact CV', type: 'checkbox' },
            ],
        },
        abroad: {
            label: 'Studies Abroad',
            parse: parseAbroadBlock,
            render: renderAbroadBlock,
            fields: [
                { key: 'title', label: 'Title (e.g. "Abroad Research Period")', type: 'text', required: true },
                { key: 'institution', label: 'Institution / Location', type: 'text', required: true },
                { key: 'date', label: 'Period', type: 'text', required: true },
                { key: 'description', label: 'Description (basic HTML allowed)', type: 'textarea' },
            ],
        },
        confs: {
            label: 'Conferences and Seminars',
            parse: parseConfsBlock,
            render: renderConfsBlock,
            fields: [
                { key: 'title', label: 'Event / conference title', type: 'text', required: true },
                { key: 'link', label: 'Link (optional, leave empty for "#")', type: 'text' },
                { key: 'subheading', label: 'Location', type: 'text' },
                { key: 'date', label: 'Date', type: 'text', required: true },
                { key: 'invitedSpeaker', label: 'Invited Speaker', type: 'checkbox' },
                { key: 'description', label: 'Description (basic HTML allowed)', type: 'textarea' },
            ],
        },
        pubs: {
            label: 'Publications',
            parse: parsePublicationBlock,
            render: renderPublicationBlock,
            fields: [
                { key: 'kicker', label: 'Type (e.g. "Conference Proceedings", "Journal Article")', type: 'text', required: true },
                { key: 'title', label: 'Publication title', type: 'text', required: true },
                { key: 'link', label: 'Link (optional, leave empty for "#")', type: 'text' },
                { key: 'badge', label: 'Badge (e.g. "To Appear" — leave empty for none)', type: 'text' },
                { key: 'subheading', label: 'Venue / Journal', type: 'text', required: true },
                { key: 'date', label: 'Year', type: 'text', required: true },
                { key: 'citation', label: 'Full citation (basic HTML allowed)', type: 'textarea' },
                { key: 'compact', label: 'Include in Compact CV', type: 'checkbox' },
            ],
        },
    };

    // -----------------------------------------------------------------
    // About + Skills (single-record / short fixed-shape editors)
    // -----------------------------------------------------------------

    const ABOUT_NAME_MARKER = '<h1 class="mb-0">';
    const ABOUT_CONTACT_MARKER = '<div class="subheading mb-5">';
    const ABOUT_SUMMARY_MARKER = '<p class="lead mb-5">';
    const ABOUT_SOCIALS_MARKER = '<div class="social-icons">';
    const SKILLS_UL_MARKER = '<ul class="fa-ul mb-0">';

    function innerOf(content, startMarker, tagName) {
        const masked = maskComments(content);
        const { start, end } = getElementRange(masked, startMarker, tagName);
        const closeTok = `</${tagName}>`;
        return content.slice(start + startMarker.length, end - closeTok.length);
    }

    function parseAbout(content) {
        const nameHtml = innerOf(content, ABOUT_NAME_MARKER, 'h1');
        const nameEl = fragment(nameHtml);
        const span = nameEl.querySelector('.text-primary');
        const lastName = span ? cleanText(span.textContent) : '';
        if (span) span.remove();
        const firstName = cleanText(nameEl.textContent);

        const contactHtml = innerOf(content, ABOUT_CONTACT_MARKER, 'div');
        const contactEl = fragment(contactHtml);
        const a = contactEl.querySelector('a');
        const email = a ? cleanText(a.textContent) : '';
        if (a) a.remove();
        const locationPhone = cleanText(contactEl.textContent);

        const summaryHtml = innerOf(content, ABOUT_SUMMARY_MARKER, 'p');
        const parts = summaryHtml.split(/<br\s*\/?>/i).map((h) => cleanText(fragment(h).textContent)).filter(Boolean);

        const socialsHtml = innerOf(content, ABOUT_SOCIALS_MARKER, 'div');
        const socialsEl = fragment(socialsHtml);
        const socials = Array.from(socialsEl.querySelectorAll('a')).map((el) => ({
            url: el.getAttribute('href') || '',
            icon: (el.querySelector('i') || {}).className || 'fas fa-link',
            title: el.getAttribute('title') || '',
        }));

        return { firstName, lastName, locationPhone, email, para1: parts[0] || '', para2: parts[1] || '', socials };
    }

    function saveAbout(content, data) {
        let updated = content;
        updated = replaceInner(
            updated, ABOUT_NAME_MARKER, 'h1',
            `\n                        ${escapeHtml(data.firstName)}\n                        <span class="text-primary">${escapeHtml(data.lastName)}</span>\n                    `
        );
        updated = replaceInner(
            updated, ABOUT_CONTACT_MARKER, 'div',
            `\n                        ${escapeHtml(data.locationPhone)}\n                        <a href="mailto:${escapeAttr(data.email)}">${escapeHtml(data.email)}</a>\n                    `
        );
        updated = replaceInner(
            updated, ABOUT_SUMMARY_MARKER, 'p',
            `\n                        ${escapeHtml(data.para1)}\n                        <br />\n                        ${escapeHtml(data.para2)}\n                    `
        );
        const socialsInner = `\n${data.socials.map((s) => {
            const titleAttr = s.title ? ` title="${escapeAttr(s.title)}"` : '';
            return `                        <a class="social-icon" target="_blank" href="${escapeAttr(s.url)}"${titleAttr}><i class="${escapeAttr(s.icon)}"></i></a>\n`;
        }).join('')}                    `;
        updated = replaceInner(updated, ABOUT_SOCIALS_MARKER, 'div', socialsInner);
        return updated;
    }

    function parseSkillsBullets(content) {
        const inner = innerOf(content, SKILLS_UL_MARKER, 'ul');
        const el = fragment(inner);
        return Array.from(el.querySelectorAll('li')).map((li) => {
            const icon = (li.querySelector('.fa-li i') || {}).className || 'fas fa-check';
            const b = li.querySelector('b');
            const label = b ? cleanText(b.textContent).replace(/:\s*$/, '') : '';
            const clone = li.cloneNode(true);
            const faLi = clone.querySelector('.fa-li');
            if (faLi) faLi.remove();
            const bTag = clone.querySelector('b');
            if (bTag) bTag.remove();
            const text = clone.innerHTML.replace(/^\s*:\s*/, '').trim();
            return { icon, label, text };
        });
    }

    function renderSkillsBullet(d) {
        return `                        <li><span class="fa-li"><i class="${escapeAttr(d.icon)}"></i></span>\n                            <b>${escapeHtml(d.label)}:</b> ${d.text}\n                        </li>\n`;
    }

    function saveSkillsBullets(content, bullets) {
        const masked = maskComments(content);
        const { start, end } = getElementRange(masked, SKILLS_UL_MARKER, 'ul');
        const innerStart = start + SKILLS_UL_MARKER.length;
        const innerEnd = end - '</ul>'.length;
        const originalInner = content.slice(innerStart, innerEnd);
        const commentMatch = originalInner.match(/(<!--[\s\S]*-->\s*)$/);
        const preservedTail = commentMatch ? commentMatch[1] : '';
        const newInner = `\n${bullets.map(renderSkillsBullet).join('')}${preservedTail}                    `;
        return content.slice(0, innerStart) + newInner + content.slice(innerEnd);
    }

    // -----------------------------------------------------------------
    // Save orchestration — every action re-fetches fresh, locates, splices,
    // commits in one request. No separate "publish batch" step.
    // -----------------------------------------------------------------

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // GitHub's read path can lag a moment behind a write that just completed, so a
    // fetch done right after a save can still return the pre-save content/sha. For a
    // single-operator tool like this, our own last successful write is a far more
    // reliable source of truth than a fresh GET — so we cache it and keep reusing it
    // across consecutive actions (e.g. delete, then immediately reorder) instead of
    // re-fetching each time. The cache is only dropped on an actual conflict (the file
    // really did change under us — someone editing it by hand, say), which forces a
    // real re-fetch before retrying.
    let fileCache = null;

    async function loadFile() {
        if (fileCache) return fileCache;
        const { content, sha } = await Github.fetchFile(FILE_PATH);
        fileCache = { content, sha };
        return fileCache;
    }

    // Resolves to the newly-published content string (not GitHub's API response) —
    // callers that need to refresh a list right after saving should render from
    // this directly instead of re-fetching, since a fetch right after a write can
    // still return the old content for a moment (see loadFile's own comment).
    async function withFreshFile(fn, attempt = 1) {
        const { content, sha } = await loadFile();
        const { updated, message } = await fn(content);
        try {
            const result = await Github.saveFile(FILE_PATH, updated, sha, message);
            const newSha = result && result.content && result.content.sha;
            fileCache = newSha ? { content: updated, sha: newSha } : null;
            return updated;
        } catch (err) {
            if (err.isConflict && attempt < 3) {
                fileCache = null;
                await delay(500);
                return withFreshFile(fn, attempt + 1);
            }
            fileCache = null;
            throw err;
        }
    }

    function saveEntryEdit(sectionId, index, data) {
        const section = SECTIONS[sectionId];
        return withFreshFile(async (content) => {
            const masked = maskComments(content);
            const blocks = listEntryBlocks(masked, sectionId);
            const b = blocks[index];
            if (!b) throw new Error('This entry no longer exists in the latest file. Reload the section.');
            const spliceStart = lineStart(content, b.start);
            // The untouched text after b.end already carries the original blank-line
            // separator before the next entry (or the section's closing tag) — drop
            // the template's own trailing newline so it isn't doubled on top of that.
            const rendered = section.render(data).replace(/\n$/, '');
            const updated = content.slice(0, spliceStart) + rendered + content.slice(b.end);
            return { updated, message: `Update ${section.label}: edit "${data.title}"` };
        });
    }

    function saveEntryAdd(sectionId, data) {
        const section = SECTIONS[sectionId];
        return withFreshFile(async (content) => {
            const masked = maskComments(content);
            const insertAt = getInsertionPoint(masked, sectionId);
            // Unlike an edit, there's no existing gap to inherit here, so add one
            // blank line ourselves to match the spacing convention between entries.
            const rendered = section.render(data) + '\n';
            const updated = content.slice(0, insertAt) + rendered + content.slice(insertAt);
            return { updated, message: `Update ${section.label}: add "${data.title}"` };
        });
    }

    function saveEntryDelete(sectionId, index, title) {
        const section = SECTIONS[sectionId];
        return withFreshFile(async (content) => {
            const masked = maskComments(content);
            const blocks = listEntryBlocks(masked, sectionId);
            const b = blocks[index];
            if (!b) throw new Error('This entry no longer exists in the latest file. Reload the section.');
            let delStart = b.start;
            while (delStart > 0 && /[ \t]/.test(content[delStart - 1])) delStart -= 1;
            if (delStart > 0 && content[delStart - 1] === '\n') delStart -= 1;
            let delEnd = b.end;
            while (delEnd < content.length && /[ \t]/.test(content[delEnd])) delEnd += 1;
            if (content[delEnd] === '\n') delEnd += 1;
            const updated = content.slice(0, delStart) + content.slice(delEnd);
            return { updated, message: `Update ${section.label}: remove "${title}"` };
        });
    }

    function saveEntryMove(sectionId, index, direction) {
        const section = SECTIONS[sectionId];
        return withFreshFile(async (content) => {
            const masked = maskComments(content);
            const blocks = listEntryBlocks(masked, sectionId);
            const otherIndex = direction === 'up' ? index - 1 : index + 1;
            if (otherIndex < 0 || otherIndex >= blocks.length) throw new Error('Cannot move further.');
            const [first, second] = index < otherIndex ? [blocks[index], blocks[otherIndex]] : [blocks[otherIndex], blocks[index]];
            const firstText = content.slice(first.start, first.end);
            const gapText = content.slice(first.end, second.start);
            const secondText = content.slice(second.start, second.end);
            const updated = content.slice(0, first.start) + secondText + gapText + firstText + content.slice(second.end);
            return { updated, message: `Update ${section.label}: reorder entries` };
        });
    }

    function saveAboutForm(data) {
        return withFreshFile(async (content) => ({
            updated: saveAbout(content, data),
            message: 'Update About section',
        }));
    }

    function saveSkillEdit(index, bullet) {
        return withFreshFile(async (content) => {
            const bullets = parseSkillsBullets(content);
            if (index === null) {
                bullets.unshift(bullet);
            } else {
                bullets[index] = bullet;
            }
            return { updated: saveSkillsBullets(content, bullets), message: `Update Skills: ${bullet.label}` };
        });
    }

    function saveSkillDelete(index) {
        return withFreshFile(async (content) => {
            const bullets = parseSkillsBullets(content);
            const removed = bullets.splice(index, 1)[0];
            return { updated: saveSkillsBullets(content, bullets), message: `Update Skills: remove "${removed ? removed.label : ''}"` };
        });
    }

    // -----------------------------------------------------------------
    // UI
    // -----------------------------------------------------------------

    const els = {};
    let currentSha = null; // display-only cache, not used for writes (each save re-fetches)

    function $(id) { return document.getElementById(id); }

    function setStatus(message, type) {
        if (!els.status) return;
        els.status.textContent = message || '';
        els.status.className = 'admin-status' + (type ? ` admin-status-${type}` : '');
        els.status.hidden = !message;
    }

    // Content placed inside a <textarea>...</textarea> is still parsed for a
    // literal "</textarea>" close tag, so a field value containing that text
    // (e.g. a paper title pulled in from ORCID/Semantic Scholar) could break
    // out and inject markup into the admin page itself, which runs with an
    // active write token in memory — escape the same way as everywhere else.
    function escapeForTextarea(str) {
        return escapeHtml(str);
    }

    function fieldValueFromForm(form, field) {
        if (field.type === 'checkbox') return form.querySelector(`[name="${field.key}"]`).checked;
        if (field.type === 'lines') {
            return form.querySelector(`[name="${field.key}"]`).value.split('\n').map((s) => s.trim()).filter(Boolean);
        }
        return form.querySelector(`[name="${field.key}"]`).value.trim();
    }

    function fieldInputHtml(field, value) {
        if (field.type === 'checkbox') {
            return `<div class="admin-field admin-field-checkbox">
                <label><input type="checkbox" name="${field.key}" ${value ? 'checked' : ''}/> ${field.label}</label>
            </div>`;
        }
        if (field.type === 'textarea' || field.type === 'lines') {
            const v = field.type === 'lines' ? (value || []).join('\n') : (value || '');
            return `<div class="admin-field">
                <label>${field.label}</label>
                <textarea name="${field.key}" rows="${field.type === 'lines' ? 4 : 5}">${escapeForTextarea(v)}</textarea>
            </div>`;
        }
        return `<div class="admin-field">
            <label>${field.label}${field.required ? ' *' : ''}</label>
            <input type="text" name="${field.key}" value="${escapeAttr(value || '')}" ${field.required ? 'required' : ''}/>
        </div>`;
    }

    function openEntryForm(sectionId, index, existingData) {
        const section = SECTIONS[sectionId];
        const isNew = index === null;
        const data = existingData || {};
        const showBibtexImport = isNew && sectionId === 'pubs';
        els.modalTitle.textContent = `${section.label} — ${isNew ? 'New entry' : 'Edit entry'}`;
        const bibtexHtml = showBibtexImport ? `<div class="admin-bibtex-import">
            <div class="admin-field">
                <label>Import from BibTeX (optional)</label>
                <textarea id="bibtexInput" rows="6" placeholder="@inproceedings{key2026,&#10;  title = {...},&#10;  author = {Last, First and Last2, First2},&#10;  ...&#10;}"></textarea>
            </div>
            <div class="admin-bibtex-actions">
                <button type="button" class="btn btn-outline-primary btn-cv" id="bibtexParseBtn">Fill form from BibTeX</button>
                <span id="bibtexError" class="admin-error" hidden></span>
            </div>
        </div>` : '';
        els.modalBody.innerHTML = `${bibtexHtml}<form id="entryForm">${section.fields.map((f) => fieldInputHtml(f, data[f.key])).join('')}
            <div class="admin-form-actions">
                <button type="submit" class="btn btn-primary btn-cv">Save and publish</button>
                <button type="button" class="btn btn-outline-primary btn-cv" id="cancelFormBtn">Cancel</button>
            </div>
        </form>`;
        $('cancelFormBtn').addEventListener('click', closeModal);
        if (showBibtexImport) {
            $('bibtexParseBtn').addEventListener('click', () => {
                const errEl = $('bibtexError');
                errEl.hidden = true;
                try {
                    const mapped = bibtexToPublicationFields($('bibtexInput').value);
                    const form = $('entryForm');
                    section.fields.forEach((f) => {
                        if (!(f.key in mapped)) return;
                        const el = form.querySelector(`[name="${f.key}"]`);
                        if (!el) return;
                        if (f.type === 'checkbox') el.checked = !!mapped[f.key];
                        else el.value = mapped[f.key];
                    });
                } catch (err) {
                    errEl.textContent = err.message;
                    errEl.hidden = false;
                }
            });
        }
        $('entryForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const newData = {};
            section.fields.forEach((f) => { newData[f.key] = fieldValueFromForm(form, f); });
            closeModal();
            setStatus(isNew ? 'Publishing new entry…' : 'Publishing edit…', 'loading');
            try {
                const updated = isNew ? await saveEntryAdd(sectionId, newData) : await saveEntryEdit(sectionId, index, newData);
                setStatus('Published. The site will update in about 30–60 seconds.', 'success');
                await renderSectionList(sectionId, updated);
            } catch (err) {
                setStatus(err.message, 'error');
            }
        });
        els.modal.hidden = false;
    }

    function closeModal() {
        els.modal.hidden = true;
        els.modalBody.innerHTML = '';
    }

    // One button, all sources: ORCID and Semantic Scholar are checked instantly
    // (browser-callable, no key needed) with results reviewable right here, same
    // as before. Google Scholar can't be — a scraping API key can't safely live
    // in this public, client-side code — so it's checked by starting the existing
    // scheduled workflow in the background (server-side, key as a repo secret);
    // if that finds anything, it opens a pull request instead of showing up in
    // this panel. Both run in parallel off the one click.
    async function handlePublicationsSync() {
        const btn = $('pubsSyncBtn');
        const panel = $('pubsSyncPanel');
        btn.disabled = true;
        btn.textContent = 'Syncing…';
        panel.innerHTML = '';
        try {
            const [syncResult, scholarResult] = await Promise.allSettled([
                syncPublicationSources(),
                Github.dispatchWorkflow(SYNC_WORKFLOW_FILE),
            ]);
            if (syncResult.status === 'rejected') throw syncResult.reason;
            const { newOnes, linkSuggestions, sources, failures, totalSite } = syncResult.value;

            const prsUrl = `https://github.com/${OWNER}/${REPO}/pulls`;
            const scholarLine = scholarResult.status === 'fulfilled'
                ? `<p class="admin-muted">Also started a Google Scholar check in the background (takes about a minute) — if it finds anything, it opens a <a href="${escapeAttr(prsUrl)}" target="_blank">pull request</a> to review.</p>`
                : `<p class="admin-error">Could not start the Google Scholar check: ${escapeHtml(scholarResult.reason.message)}</p>`;

            const checkedLine = sources.length
                ? `Checked ${sources.map((s) => `${s.name} (${s.total})`).join(' and ')} against ${totalSite} publications on the site.`
                : 'Could not check any source.';
            const failureLines = failures.map((f) => `<p class="admin-error">${escapeHtml(f.name)}: ${escapeHtml(f.message)}</p>`).join('');

            if (!newOnes.length && !linkSuggestions.length) {
                panel.innerHTML = `<p class="admin-muted">${checkedLine} Nothing new to review.</p>${failureLines}${scholarLine}`;
            } else {
                const newHtml = newOnes.map((w, i) => `
                    <div class="admin-entry-row">
                        <div class="admin-entry-info">
                            <strong>${escapeHtml(w.title)}</strong>
                            <span class="admin-entry-date">${escapeHtml(w.journal || w.kicker)}${w.year ? ' · ' + escapeHtml(w.year) : ''} · via ${escapeHtml(w.foundVia)}</span>
                        </div>
                        <div class="admin-entry-actions">
                            <button class="admin-icon-btn" data-pubsync-add="${i}">Review and add…</button>
                        </div>
                    </div>`).join('');
                const linkHtml = linkSuggestions.map((s, i) => `
                    <div class="admin-entry-row">
                        <div class="admin-entry-info">
                            <strong>${escapeHtml(s.site.title)}</strong>
                            <span class="admin-entry-date">On the site, but ${escapeHtml(s.foundVia)} has a link it's missing</span>
                        </div>
                        <div class="admin-entry-actions">
                            <button class="admin-icon-btn" data-pubsync-link="${i}">Add missing link…</button>
                        </div>
                    </div>`).join('');
                panel.innerHTML = `
                    <p class="admin-muted">${checkedLine}</p>
                    ${failureLines}
                    ${newOnes.length ? `<h4 class="admin-subhead">New, not on the site (${newOnes.length})</h4><div class="admin-entry-list">${newHtml}</div>` : ''}
                    ${linkSuggestions.length ? `<h4 class="admin-subhead">On the site with no link (${linkSuggestions.length})</h4><div class="admin-entry-list">${linkHtml}</div>` : ''}
                    <p class="admin-note admin-muted">ORCID/Semantic Scholar data is often less complete than what's already on the site, so nothing here publishes automatically — each button opens the normal form, pre-filled, for you to check before saving.</p>
                    ${scholarLine}
                `;
                panel.querySelectorAll('[data-pubsync-add]').forEach((b) => {
                    b.addEventListener('click', () => {
                        const w = newOnes[Number(b.dataset.pubsyncAdd)];
                        openEntryForm('pubs', null, {
                            kicker: w.kicker, title: w.title, link: w.link, badge: '',
                            subheading: w.journal, date: w.year, citation: '', compact: false,
                        });
                    });
                });
                panel.querySelectorAll('[data-pubsync-link]').forEach((b) => {
                    b.addEventListener('click', () => {
                        const s = linkSuggestions[Number(b.dataset.pubsyncLink)];
                        openEntryForm('pubs', s.site.index, { ...s.site, link: s.work.link });
                    });
                });
            }
        } catch (err) {
            panel.innerHTML = `<p class="admin-error">${escapeHtml(err.message)}</p>`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Sync publications';
        }
    }

    async function handleConfsCoverageCheck() {
        const btn = $('coverageCheckBtn');
        const panel = $('coveragePanel');
        btn.disabled = true;
        btn.textContent = 'Checking…';
        panel.innerHTML = '';
        try {
            const { unmatched, totalPubs } = await findPublicationsWithoutConfEntry();
            if (!unmatched.length) {
                panel.innerHTML = `<p class="admin-muted">Checked ${totalPubs} publications — each one looks like it has a matching conference entry (or is a journal article).</p>`;
            } else {
                const rows = unmatched.map((p, i) => `
                    <div class="admin-entry-row">
                        <div class="admin-entry-info">
                            <strong>${escapeHtml(p.title)}</strong>
                            <span class="admin-entry-date">${escapeHtml(p.subheading)}${p.date ? ' · ' + escapeHtml(p.date) : ''}</span>
                        </div>
                        <div class="admin-entry-actions">
                            <button class="admin-icon-btn" data-cov-add="${i}">+ Add conference entry…</button>
                        </div>
                    </div>`).join('');
                panel.innerHTML = `
                    <p class="admin-muted">Checked ${totalPubs} publications. ${unmatched.length} don't look matched to a Conferences and Seminars entry (this is fuzzy — some may genuinely be journal-only, check before adding):</p>
                    <div class="admin-entry-list">${rows}</div>
                `;
                panel.querySelectorAll('[data-cov-add]').forEach((b) => {
                    b.addEventListener('click', () => {
                        const p = unmatched[Number(b.dataset.covAdd)];
                        openEntryForm('confs', null, {
                            title: p.subheading, link: p.link, subheading: '',
                            date: p.date, invitedSpeaker: false, description: '',
                        });
                    });
                });
            }
        } catch (err) {
            panel.innerHTML = `<p class="admin-error">${escapeHtml(err.message)}</p>`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Check publications without a conference entry';
        }
    }

    // `preloadedContent`, when given, is rendered from directly instead of fetching —
    // used right after a save, where the content we just wrote is already known and
    // more trustworthy than a fetch (which can briefly still return the old version).
    async function renderSectionList(sectionId, preloadedContent) {
        const section = SECTIONS[sectionId];
        let extraBtn = '';
        if (sectionId === 'pubs') extraBtn = '<button class="btn btn-outline-primary btn-cv" id="pubsSyncBtn">Sync publications</button>';
        if (sectionId === 'confs') extraBtn = '<button class="btn btn-outline-primary btn-cv" id="coverageCheckBtn">Check publications without a conference entry</button>';
        els.content.innerHTML = `<div class="admin-section-header">
            <h2>${section.label}</h2>
            <div class="admin-section-header-actions">
                ${extraBtn}
                <button class="btn btn-primary btn-cv" id="addEntryBtn">+ New entry</button>
            </div>
        </div>
        ${sectionId === 'pubs' ? '<div id="pubsSyncPanel" class="admin-orcid-panel"></div>' : ''}
        ${sectionId === 'confs' ? '<div id="coveragePanel" class="admin-orcid-panel"></div>' : ''}
        <div id="entryList" class="admin-entry-list"><p class="admin-muted">Loading…</p></div>`;
        $('addEntryBtn').addEventListener('click', () => openEntryForm(sectionId, null, null));
        if (sectionId === 'pubs') $('pubsSyncBtn').addEventListener('click', handlePublicationsSync);
        if (sectionId === 'confs') $('coverageCheckBtn').addEventListener('click', handleConfsCoverageCheck);

        try {
            const content = preloadedContent !== undefined ? preloadedContent : (await loadFile()).content;
            const masked = maskComments(content);
            const blocks = listEntryBlocks(masked, sectionId);
            const entries = blocks.map((b) => section.parse(content.slice(b.start, b.end)));
            const list = $('entryList');
            if (!entries.length) {
                list.innerHTML = '<p class="admin-muted">No entries in this section.</p>';
                return;
            }
            list.innerHTML = entries.map((d, i) => `
                <div class="admin-entry-row">
                    <div class="admin-entry-info">
                        <strong>${escapeHtml(d.title)}</strong>
                        <span class="admin-entry-date">${escapeHtml(d.date || '')}</span>
                    </div>
                    <div class="admin-entry-actions">
                        <button class="admin-icon-btn" data-action="up" data-index="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
                        <button class="admin-icon-btn" data-action="down" data-index="${i}" title="Move down" ${i === entries.length - 1 ? 'disabled' : ''}>&darr;</button>
                        <button class="admin-icon-btn" data-action="edit" data-index="${i}" title="Edit">Edit</button>
                        <button class="admin-icon-btn admin-icon-btn-danger" data-action="delete" data-index="${i}" title="Delete">Delete</button>
                    </div>
                </div>`).join('');

            list.querySelectorAll('[data-action]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const i = Number(btn.dataset.index);
                    const action = btn.dataset.action;
                    if (action === 'edit') {
                        openEntryForm(sectionId, i, entries[i]);
                        return;
                    }
                    if (action === 'delete') {
                        if (!confirm(`Permanently delete "${entries[i].title}"?`)) return;
                        setStatus('Publishing deletion…', 'loading');
                        try {
                            const updated = await saveEntryDelete(sectionId, i, entries[i].title);
                            setStatus('Published. The site will update in about 30–60 seconds.', 'success');
                            await renderSectionList(sectionId, updated);
                        } catch (err) {
                            setStatus(err.message, 'error');
                        }
                        return;
                    }
                    if (action === 'up' || action === 'down') {
                        setStatus('Publishing new order…', 'loading');
                        try {
                            const updated = await saveEntryMove(sectionId, i, action === 'up' ? 'up' : 'down');
                            setStatus('Published. The site will update in about 30–60 seconds.', 'success');
                            await renderSectionList(sectionId, updated);
                        } catch (err) {
                            setStatus(err.message, 'error');
                        }
                    }
                });
            });
        } catch (err) {
            $('entryList').innerHTML = `<p class="admin-error">${escapeHtml(err.message)}</p>`;
        }
    }

    // -----------------------------------------------------------------
    // Profile photo upload.
    //
    // Security/correctness checks, in order: (1) a hard cap on the raw
    // upload before touching it, (2) a magic-byte signature check so a
    // renamed non-image file is rejected outright — SVG is deliberately
    // never accepted, since it's markup that can carry a <script>, not
    // pixel data, (3) actually decoding it via createImageBitmap, which
    // throws on anything that merely *looks* like an image at the byte
    // level but isn't a real, renderable one, (4) a dimension sanity cap,
    // then (5) every upload is re-encoded fresh as JPEG via <canvas> —
    // this resizes/compresses it, strips all metadata (EXIF/GPS/etc.) and
    // any polyglot-file trickery, and is what's actually sent to GitHub,
    // never the original bytes.
    // -----------------------------------------------------------------

    const PROFILE_PHOTO_PATH = 'assets/img/profile.jpg';
    const PHOTO_MAX_INPUT_BYTES = 15 * 1024 * 1024;
    const PHOTO_MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
    const PHOTO_MAX_DIMENSION = 1200;
    const PHOTO_MAX_SOURCE_DIMENSION = 8000;

    const IMAGE_SIGNATURES = [
        { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
        { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
        { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
        { type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offsetCheck: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
    ];

    function sniffImageType(bytes) {
        for (const sig of IMAGE_SIGNATURES) {
            if (!sig.bytes.every((b, i) => bytes[i] === b)) continue;
            if (sig.offsetCheck) {
                const { offset, bytes: obytes } = sig.offsetCheck;
                if (!obytes.every((b, i) => bytes[offset + i] === b)) continue;
            }
            return sig.type;
        }
        return null;
    }

    async function processImageFile(file) {
        if (!file) throw new Error('No file selected.');
        if (file.size > PHOTO_MAX_INPUT_BYTES) {
            throw new Error(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — please choose an image under ${PHOTO_MAX_INPUT_BYTES / 1024 / 1024} MB.`);
        }

        const buf = await file.arrayBuffer();
        const head = new Uint8Array(buf.slice(0, 16));
        if (!sniffImageType(head)) {
            throw new Error('This does not look like a valid JPEG, PNG, GIF or WebP file. SVG and other formats are not accepted.');
        }

        let bitmap;
        try {
            bitmap = await createImageBitmap(new Blob([buf]), { imageOrientation: 'from-image' });
        } catch (err) {
            throw new Error('The file looked like an image but could not be decoded — it may be corrupted.');
        }
        if (!bitmap.width || !bitmap.height) throw new Error('The image has invalid dimensions.');
        if (bitmap.width > PHOTO_MAX_SOURCE_DIMENSION || bitmap.height > PHOTO_MAX_SOURCE_DIMENSION) {
            throw new Error(`Image dimensions are too large (${bitmap.width}×${bitmap.height}px).`);
        }

        const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
        const outW = Math.max(1, Math.round(bitmap.width * scale));
        const outH = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(bitmap, 0, 0, outW, outH);
        bitmap.close();

        const outBlob = await new Promise((resolve, reject) => {
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the resized image.'))), 'image/jpeg', 0.85);
        });
        if (outBlob.size > PHOTO_MAX_OUTPUT_BYTES) {
            throw new Error('The processed image is still too large — try a smaller or simpler photo.');
        }
        return { blob: outBlob, width: outW, height: outH };
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(new Error('Could not read the processed image.'));
            reader.readAsDataURL(blob);
        });
    }

    async function uploadProfilePhoto(blob) {
        const meta = await Github.getFileMeta(PROFILE_PHOTO_PATH);
        const base64 = await blobToBase64(blob);
        await Github.saveBinaryFile(PROFILE_PHOTO_PATH, base64, meta.sha, 'Update profile photo');
    }

    async function renderAboutTab() {
        els.content.innerHTML = '<div class="admin-section-header"><h2>About</h2></div><div id="aboutFormWrap"><p class="admin-muted">Loading…</p></div>';
        try {
            const { content } = await loadFile();
            const data = parseAbout(content);
            const wrap = $('aboutFormWrap');
            wrap.innerHTML = `<div class="admin-field admin-photo-field">
                <label>Profile photo</label>
                <div class="admin-photo-row">
                    <div class="admin-photo-preview">
                        <img id="currentPhotoPreview" alt="Current profile photo" />
                        <span class="admin-photo-caption">Current</span>
                    </div>
                    <div class="admin-photo-preview" id="newPhotoPreviewWrap" hidden>
                        <img id="newPhotoPreview" alt="New profile photo preview" />
                        <span class="admin-photo-caption">New (<span id="newPhotoDims"></span>, <span id="newPhotoSize"></span>)</span>
                    </div>
                </div>
                <input type="file" id="photoInput" accept="image/jpeg,image/png,image/gif,image/webp" />
                <p class="admin-muted admin-note">JPEG, PNG, GIF or WebP, up to 15 MB. Always resized and re-compressed to a JPEG (max ${PHOTO_MAX_DIMENSION}px, ~85% quality) before upload, which also strips any embedded metadata. SVG is not accepted.</p>
                <div id="photoError" class="admin-error" hidden></div>
                <button type="button" class="btn btn-primary btn-cv" id="uploadPhotoBtn" disabled>Upload and publish photo</button>
            </div>
            <form id="aboutForm">
                <div class="admin-field"><label>First name</label><input type="text" name="firstName" value="${escapeAttr(data.firstName)}" required/></div>
                <div class="admin-field"><label>Last name (highlighted)</label><input type="text" name="lastName" value="${escapeAttr(data.lastName)}" required/></div>
                <div class="admin-field"><label>Location, phone</label><input type="text" name="locationPhone" value="${escapeAttr(data.locationPhone)}" required/></div>
                <div class="admin-field"><label>Email</label><input type="text" name="email" value="${escapeAttr(data.email)}" required/></div>
                <div class="admin-field"><label>Summary — paragraph 1</label><textarea name="para1" rows="4">${escapeForTextarea(data.para1)}</textarea></div>
                <div class="admin-field"><label>Summary — paragraph 2</label><textarea name="para2" rows="4">${escapeForTextarea(data.para2)}</textarea></div>
                <div class="admin-field"><label>Social links (one per line: "font awesome icon | url | optional label")</label>
                    <textarea name="socials" rows="5">${escapeForTextarea(data.socials.map((s) => `${s.icon} | ${s.url}${s.title ? ` | ${s.title}` : ''}`).join('\n'))}</textarea>
                </div>
                <div class="admin-form-actions"><button type="submit" class="btn btn-primary btn-cv">Save and publish</button></div>
            </form>`;
            $('aboutForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const f = e.target;
                const socials = f.socials.value.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
                    const [icon, url, title] = line.split('|').map((s) => (s || '').trim());
                    return { icon, url, title: title || '' };
                });
                const newData = {
                    firstName: f.firstName.value.trim(),
                    lastName: f.lastName.value.trim(),
                    locationPhone: f.locationPhone.value.trim(),
                    email: f.email.value.trim(),
                    para1: f.para1.value.trim(),
                    para2: f.para2.value.trim(),
                    socials,
                };
                setStatus('Publishing…', 'loading');
                try {
                    await saveAboutForm(newData);
                    setStatus('Published. The site will update in about 30–60 seconds.', 'success');
                } catch (err) {
                    setStatus(err.message, 'error');
                }
            });

            const photoMeta = await Github.getFileMeta(PROFILE_PHOTO_PATH).catch(() => ({ downloadUrl: null }));
            if (photoMeta.downloadUrl) $('currentPhotoPreview').src = `${photoMeta.downloadUrl}?t=${Date.now()}`;

            const photoInput = $('photoInput');
            const uploadPhotoBtn = $('uploadPhotoBtn');
            const photoError = $('photoError');
            let pendingPhotoBlob = null;

            photoInput.addEventListener('change', async () => {
                photoError.hidden = true;
                uploadPhotoBtn.disabled = true;
                $('newPhotoPreviewWrap').hidden = true;
                pendingPhotoBlob = null;
                const file = photoInput.files[0];
                if (!file) return;
                try {
                    const { blob, width, height } = await processImageFile(file);
                    pendingPhotoBlob = blob;
                    $('newPhotoPreview').src = URL.createObjectURL(blob);
                    $('newPhotoDims').textContent = `${width}×${height}`;
                    $('newPhotoSize').textContent = `${Math.round(blob.size / 1024)} KB`;
                    $('newPhotoPreviewWrap').hidden = false;
                    uploadPhotoBtn.disabled = false;
                } catch (err) {
                    photoError.textContent = err.message;
                    photoError.hidden = false;
                }
            });

            uploadPhotoBtn.addEventListener('click', async () => {
                if (!pendingPhotoBlob) return;
                uploadPhotoBtn.disabled = true;
                uploadPhotoBtn.textContent = 'Uploading…';
                setStatus('Publishing new photo…', 'loading');
                try {
                    await uploadProfilePhoto(pendingPhotoBlob);
                    setStatus('Published. The site will update in about 30–60 seconds.', 'success');
                    photoInput.value = '';
                    $('newPhotoPreviewWrap').hidden = true;
                    pendingPhotoBlob = null;
                } catch (err) {
                    setStatus(err.message, 'error');
                    uploadPhotoBtn.disabled = false;
                } finally {
                    uploadPhotoBtn.textContent = 'Upload and publish photo';
                }
            });
        } catch (err) {
            $('aboutFormWrap').innerHTML = `<p class="admin-error">${escapeHtml(err.message)}</p>`;
        }
    }

    function openSkillForm(index, existing) {
        const data = existing || { icon: 'fas fa-check', label: '', text: '' };
        els.modalTitle.textContent = index === null ? 'Skills — New entry' : 'Skills — Edit entry';
        els.modalBody.innerHTML = `<form id="skillForm">
            <div class="admin-field"><label>Icon (Font Awesome class, e.g. "fas fa-tools")</label><input type="text" name="icon" value="${escapeAttr(data.icon)}" required/></div>
            <div class="admin-field"><label>Label (e.g. "ML Frameworks")</label><input type="text" name="label" value="${escapeAttr(data.label)}" required/></div>
            <div class="admin-field"><label>Text</label><textarea name="text" rows="3">${escapeForTextarea(data.text)}</textarea></div>
            <div class="admin-form-actions">
                <button type="submit" class="btn btn-primary btn-cv">Save and publish</button>
                <button type="button" class="btn btn-outline-primary btn-cv" id="cancelFormBtn">Cancel</button>
            </div>
        </form>`;
        $('cancelFormBtn').addEventListener('click', closeModal);
        $('skillForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const bullet = { icon: f.icon.value.trim(), label: f.label.value.trim(), text: f.text.value.trim() };
            closeModal();
            setStatus('Publishing…', 'loading');
            try {
                const updated = await saveSkillEdit(index, bullet);
                setStatus('Published. The site will update in about 30–60 seconds.', 'success');
                await renderSkillsTab(updated);
            } catch (err) {
                setStatus(err.message, 'error');
            }
        });
        els.modal.hidden = false;
    }

    async function renderSkillsTab(preloadedContent) {
        els.content.innerHTML = `<div class="admin-section-header"><h2>Skills</h2><button class="btn btn-primary btn-cv" id="addSkillBtn">+ New entry</button></div>
        <div id="skillsList" class="admin-entry-list"><p class="admin-muted">Loading…</p></div>
        <p class="admin-muted admin-note">The "Programming Languages &amp; Tools" icon row is not managed by this editor.</p>`;
        $('addSkillBtn').addEventListener('click', () => openSkillForm(null, null));
        try {
            const content = preloadedContent !== undefined ? preloadedContent : (await loadFile()).content;
            const bullets = parseSkillsBullets(content);
            const list = $('skillsList');
            list.innerHTML = bullets.map((b, i) => `
                <div class="admin-entry-row">
                    <div class="admin-entry-info"><strong>${escapeHtml(b.label)}</strong></div>
                    <div class="admin-entry-actions">
                        <button class="admin-icon-btn" data-action="edit" data-index="${i}">Edit</button>
                        <button class="admin-icon-btn admin-icon-btn-danger" data-action="delete" data-index="${i}">Delete</button>
                    </div>
                </div>`).join('');
            list.querySelectorAll('[data-action]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const i = Number(btn.dataset.index);
                    if (btn.dataset.action === 'edit') { openSkillForm(i, bullets[i]); return; }
                    if (!confirm(`Delete "${bullets[i].label}"?`)) return;
                    setStatus('Publishing deletion…', 'loading');
                    try {
                        const updated = await saveSkillDelete(i);
                        setStatus('Published. The site will update in about 30–60 seconds.', 'success');
                        await renderSkillsTab(updated);
                    } catch (err) {
                        setStatus(err.message, 'error');
                    }
                });
            });
        } catch (err) {
            $('skillsList').innerHTML = `<p class="admin-error">${escapeHtml(err.message)}</p>`;
        }
    }

    const TABS = [
        { id: 'about', label: 'About', render: renderAboutTab },
        { id: 'skills', label: 'Skills', render: renderSkillsTab },
        { id: 'experience', label: 'Experience', render: () => renderSectionList('experience') },
        { id: 'education', label: 'Education', render: () => renderSectionList('education') },
        { id: 'abroad', label: 'Studies Abroad', render: () => renderSectionList('abroad') },
        { id: 'confs', label: 'Conferences and Seminars', render: () => renderSectionList('confs') },
        { id: 'pubs', label: 'Publications', render: () => renderSectionList('pubs') },
    ];

    function selectTab(tabId) {
        els.tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
        const tab = TABS.find((t) => t.id === tabId);
        setStatus('');
        tab.render();
    }

    function buildEditorShell() {
        els.tabs.innerHTML = TABS.map((t) => `<button class="admin-tab" data-tab="${t.id}">${t.label}</button>`).join('');
        els.tabs.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => selectTab(btn.dataset.tab));
        });
        selectTab(TABS[0].id);
    }

    async function handleConnect(token) {
        els.loginError.hidden = true;
        els.connectBtn.disabled = true;
        els.connectBtn.textContent = 'Checking…';
        Github.token = token;
        try {
            await Github.validateToken();
            sessionStorage.setItem(TOKEN_KEY, token);
            els.loginScreen.hidden = true;
            els.editorScreen.hidden = false;
            buildEditorShell();
        } catch (err) {
            els.loginError.textContent = err.message;
            els.loginError.hidden = false;
        } finally {
            els.connectBtn.disabled = false;
            els.connectBtn.textContent = 'Connect';
        }
    }

    function handleLogout() {
        sessionStorage.removeItem(TOKEN_KEY);
        Github.token = null;
        fileCache = null;
        els.editorScreen.hidden = true;
        els.loginScreen.hidden = false;
        els.tokenInput.value = '';
    }

    function init() {
        els.loginScreen = $('loginScreen');
        els.editorScreen = $('editorScreen');
        els.tokenInput = $('tokenInput');
        els.connectBtn = $('connectBtn');
        els.loginError = $('loginError');
        els.tabs = $('adminTabs');
        els.content = $('adminContent');
        els.status = $('adminStatus');
        els.modal = $('entryModal');
        els.modalTitle = $('entryModalTitle');
        els.modalBody = $('entryModalBody');
        els.logoutBtn = $('logoutBtn');

        els.connectBtn.addEventListener('click', () => {
            const token = els.tokenInput.value.trim();
            if (token) handleConnect(token);
        });
        els.tokenInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') els.connectBtn.click();
        });
        els.logoutBtn.addEventListener('click', handleLogout);
        $('closeModalBtn').addEventListener('click', closeModal);

        const savedToken = sessionStorage.getItem(TOKEN_KEY);
        if (savedToken) {
            els.tokenInput.value = savedToken;
            handleConnect(savedToken);
        }
    }

    window.addEventListener('DOMContentLoaded', init);
})();
