/*!
 * Collapses long entry lists (Experience, Conferences and Seminars,
 * Publications) down to a handful of entries with a "Show all" button, so
 * the page doesn't sprawl. Short sections (Education, Studies Abroad) are
 * left alone — there's nothing worth hiding there.
 *
 * Purely a runtime/visual behaviour: hidden entries stay in the DOM (just
 * display:none), and no entry's own markup is ever touched. That matters
 * because js/cv-pdf.js scrapes the full DOM to build the PDFs (hidden
 * elements are still readable via the DOM, so PDFs are unaffected either
 * way) and js/admin.js edits the raw page source directly, independent of
 * this script entirely.
 */
(function () {
    'use strict';

    const COLLAPSE_CONFIG = {
        experience: 3,
        confs: 4,
        pubs: 5,
    };

    function setupSection(sectionId, visibleCount) {
        const section = document.getElementById(sectionId);
        if (!section) return;
        const content = section.querySelector('.resume-section-content');
        if (!content) return;
        const entries = Array.from(content.children).filter((el) => el.classList.contains('d-flex'));
        if (entries.length <= visibleCount) return;

        const hidden = entries.slice(visibleCount);
        hidden.forEach((el) => el.classList.add('resume-entry-hidden'));

        const wrap = document.createElement('div');
        wrap.className = 'resume-show-more-wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-outline-primary btn-cv';
        btn.textContent = `Show all (${entries.length})`;
        btn.setAttribute('aria-expanded', 'false');
        wrap.appendChild(btn);
        entries[visibleCount - 1].insertAdjacentElement('afterend', wrap);

        let expanded = false;
        btn.addEventListener('click', () => {
            expanded = !expanded;
            hidden.forEach((el) => el.classList.toggle('resume-entry-hidden', !expanded));
            btn.textContent = expanded ? 'Show less' : `Show all (${entries.length})`;
            btn.setAttribute('aria-expanded', String(expanded));
            if (!expanded) {
                entries[visibleCount - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    window.addEventListener('DOMContentLoaded', () => {
        Object.keys(COLLAPSE_CONFIG).forEach((sectionId) => setupSection(sectionId, COLLAPSE_CONFIG[sectionId]));
    });
})();
