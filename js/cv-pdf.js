/*!
 * CV PDF generator
 *
 * Builds two downloadable PDFs ("Full" and "Compact") entirely from the
 * content already present in this page's DOM (About/Skills/Experience/
 * Education/Studies Abroad/Conferences/Publications sections), so the PDFs
 * always stay in sync with what is written in index.html.
 *
 * The "Compact" PDF only includes the entries explicitly flagged with
 * data-compact="true" in the HTML (plus Skills and a trimmed summary),
 * and is designed to fit a single A4 page.
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // DOM -> data extraction
    // ---------------------------------------------------------------------

    function cleanText(str) {
        return (str || '')
            // strip control chars, Unicode noncharacters, zero-width spaces, BOM and soft hyphens
            // that sometimes sneak in from copy-pasted content and would otherwise break PDF text rendering
            .replace(/[\u0000-\u001F\u007F-\u009F﷐-﷯￾￿​-‍﻿­]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function textOf(el) {
        return el ? cleanText(el.textContent) : '';
    }

    function shorten(text, maxLen) {
        if (!text || text.length <= maxLen) return text || '';
        const truncated = text.slice(0, maxLen);
        const lastDot = truncated.lastIndexOf('. ');
        if (lastDot > maxLen * 0.5) return truncated.slice(0, lastDot + 1);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '…';
    }

    function displayUrl(url) {
        return (url || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
    }

    function parseAbout() {
        const section = document.getElementById('about');
        const name = textOf(section.querySelector('h1'));

        const subEl = section.querySelector('.subheading');
        let locationPhone = '';
        let email = '';
        if (subEl) {
            const clone = subEl.cloneNode(true);
            const aEl = clone.querySelector('a');
            if (aEl) {
                email = aEl.textContent.trim();
                aEl.remove();
            }
            locationPhone = cleanText(clone.textContent);
        }

        const lead = section.querySelector('p.lead');
        let paragraphs = [];
        if (lead) {
            paragraphs = lead.innerHTML
                .split(/<br\s*\/?>/i)
                .map((html) => {
                    const tmp = document.createElement('div');
                    tmp.innerHTML = html;
                    return cleanText(tmp.textContent);
                })
                .filter(Boolean);
        }

        const socials = Array.from(section.querySelectorAll('.social-icons a'))
            .map((a) => a.href)
            .filter(Boolean);

        return { name, locationPhone, email, paragraphs, socials };
    }

    function parseSkills() {
        const section = document.getElementById('skills');
        if (!section) return [];
        return Array.from(section.querySelectorAll('ul.fa-ul > li'))
            .map((li) => {
                const clone = li.cloneNode(true);
                const icon = clone.querySelector('.fa-li');
                if (icon) icon.remove();
                return cleanText(clone.textContent);
            })
            .filter(Boolean);
    }

    function parseExperience() {
        const section = document.getElementById('experience');
        if (!section) return [];
        return Array.from(section.querySelectorAll(':scope > .resume-section-content > .d-flex')).map((block) => {
            const flexGrow = block.querySelector('.flex-grow-1');
            const title = textOf(flexGrow.querySelector('h3'));
            const subheading = textOf(flexGrow.querySelector('.subheading'));
            const date = textOf(block.querySelector('.flex-shrink-0'));
            const intro = Array.from(flexGrow.querySelectorAll('p')).map(textOf).filter(Boolean);
            const bullets = Array.from(flexGrow.querySelectorAll('li')).map(textOf).filter(Boolean);
            const compact = block.dataset.compact === 'true';
            return { title, subheading, date, intro, bullets, compact };
        });
    }

    function parseEducation() {
        const section = document.getElementById('education');
        if (!section) return [];
        return Array.from(section.querySelectorAll(':scope > .resume-section-content > .d-flex')).map((block) => {
            const flexGrow = block.querySelector('.flex-grow-1');
            const h3 = flexGrow.querySelector('h3');
            const title = textOf(h3);
            const subheading = textOf(flexGrow.querySelector('.subheading'));
            const date = textOf(block.querySelector('.flex-shrink-0'));
            const lines = [];
            Array.from(flexGrow.children).forEach((child) => {
                if (child === h3) return;
                if (child.classList && child.classList.contains('subheading')) return;
                const t = textOf(child);
                if (t) lines.push(t);
            });
            const compact = block.dataset.compact === 'true';
            return { title, subheading, date, lines, compact };
        });
    }

    function parseAbroad() {
        const section = document.getElementById('abroad');
        if (!section) return [];
        return Array.from(section.querySelectorAll(':scope > .resume-section-content > .d-flex')).map((block) => {
            const flexGrow = block.querySelector('.flex-grow-1');
            const title = textOf(flexGrow.querySelector('h3'));
            const h4 = flexGrow.querySelector('h4');
            const institution = textOf(h4);
            const date = textOf(block.querySelector('.flex-shrink-0'));
            const descEl = h4 ? h4.nextElementSibling : null;
            const description = textOf(descEl);
            return { title, institution, date, description };
        });
    }

    function parseConfs() {
        const section = document.getElementById('confs');
        if (!section) return [];
        return Array.from(section.querySelectorAll(':scope > .resume-section-content > .d-flex')).map((block) => {
            const flexGrow = block.querySelector('.flex-grow-1');
            const h3 = flexGrow.querySelector('h3');
            const linkEl = h3 ? h3.querySelector('a') : null;
            const title = textOf(h3);
            const link = linkEl && linkEl.getAttribute('href') !== '#' ? linkEl.href : '';
            const subEl = flexGrow.querySelector('.subheading');
            const subheading = textOf(subEl);
            const descEl = subEl ? subEl.nextElementSibling : null;
            const description = textOf(descEl);
            const date = textOf(block.querySelector('.flex-shrink-0'));
            return { title, link, subheading, description, date };
        });
    }

    function parsePublications() {
        const section = document.getElementById('pubs');
        if (!section) return [];
        return Array.from(section.querySelectorAll(':scope > .resume-section-content > .d-flex')).map((block) => {
            const flexGrow = block.querySelector('.flex-grow-1');
            const kicker = textOf(flexGrow.querySelector('h4'));
            const h3 = flexGrow.querySelector('h3');
            const linkEl = h3 ? h3.querySelector('a') : null;
            const link = linkEl && linkEl.getAttribute('href') !== '#' ? linkEl.href : '';
            const titleClone = h3.cloneNode(true);
            const badgeEl = titleClone.querySelector('.badge');
            const badge = textOf(badgeEl);
            if (badgeEl) badgeEl.remove();
            const title = cleanText(titleClone.textContent);
            const subEl = flexGrow.querySelector('.subheading');
            const subheading = textOf(subEl);
            const citationEl = subEl ? subEl.nextElementSibling : null;
            const citation = textOf(citationEl);
            const date = textOf(block.querySelector('.flex-shrink-0'));
            const compact = block.dataset.compact === 'true';
            return { kicker, title, link, badge, subheading, citation, date, compact };
        });
    }

    function gatherData() {
        return {
            about: parseAbout(),
            skills: parseSkills(),
            experience: parseExperience(),
            education: parseEducation(),
            abroad: parseAbroad(),
            confs: parseConfs(),
            publications: parsePublications(),
            pageUrl: window.location.href,
        };
    }

    // ---------------------------------------------------------------------
    // PDF layout helpers
    // ---------------------------------------------------------------------

    const PAGE_W = 210;
    const PAGE_H = 297;
    const MARGIN = 16;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const ACCENT = [51, 91, 116];
    const DARK = [33, 37, 41];
    const MUTED = [105, 105, 105];

    function lh(fontPt, factor) {
        return fontPt * 0.3528 * (factor || 1.25);
    }

    function checkPageBreak(doc, pos, needed) {
        if (pos.y + needed > PAGE_H - MARGIN) {
            doc.addPage();
            pos.y = MARGIN;
        }
    }

    function sectionHeader(doc, pos, title, cfg) {
        checkPageBreak(doc, pos, 12);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(cfg.section);
        doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
        doc.text(title.toUpperCase(), MARGIN, pos.y);
        pos.y += 1.6;
        doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
        doc.setLineWidth(0.5);
        doc.line(MARGIN, pos.y, PAGE_W - MARGIN, pos.y);
        pos.y += cfg.afterSectionGap;
        doc.setTextColor(DARK[0], DARK[1], DARK[2]);
    }

    function paragraph(doc, pos, text, opts) {
        if (!text) return;
        const o = Object.assign({ x: MARGIN, width: CONTENT_W, size: 9.5, color: DARK, font: 'normal', factor: 1.28, gapAfter: 0 }, opts);
        doc.setFont('helvetica', o.font);
        doc.setFontSize(o.size);
        doc.setTextColor(o.color[0], o.color[1], o.color[2]);
        const lines = doc.splitTextToSize(text, o.width);
        const step = lh(o.size, o.factor);
        lines.forEach((line) => {
            checkPageBreak(doc, pos, step);
            doc.text(line, o.x, pos.y);
            pos.y += step;
        });
        pos.y += o.gapAfter;
    }

    function bulletList(doc, pos, items, cfg) {
        const indent = 4.5;
        items.forEach((item) => {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(cfg.body);
            doc.setTextColor(DARK[0], DARK[1], DARK[2]);
            const lines = doc.splitTextToSize(item, CONTENT_W - indent);
            const step = lh(cfg.body, 1.25);
            lines.forEach((line, i) => {
                checkPageBreak(doc, pos, step);
                if (i === 0) doc.text('•', MARGIN, pos.y);
                doc.text(line, MARGIN + indent, pos.y);
                pos.y += step;
            });
        });
    }

    function entryHeaderLine(doc, pos, title, date, cfg) {
        checkPageBreak(doc, pos, lh(cfg.title, 1.2));
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(cfg.title);
        doc.setTextColor(DARK[0], DARK[1], DARK[2]);
        doc.text(title, MARGIN, pos.y);
        if (date) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(cfg.small);
            doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
            doc.text(date, PAGE_W - MARGIN, pos.y, { align: 'right' });
        }
        pos.y += lh(cfg.title, 1.2);
    }

    function subheadingLine(doc, pos, text, cfg, dateOnRight) {
        if (!text && !dateOnRight) return;
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(cfg.small);
        doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
        const width = dateOnRight ? CONTENT_W - 45 : CONTENT_W;
        const lines = doc.splitTextToSize(text || '', width);
        const step = lh(cfg.small, 1.25);
        lines.forEach((line, i) => {
            checkPageBreak(doc, pos, step);
            doc.text(line, MARGIN, pos.y);
            if (i === 0 && dateOnRight) {
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
                doc.text(dateOnRight, PAGE_W - MARGIN, pos.y, { align: 'right' });
                doc.setFont('helvetica', 'italic');
                doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
            }
            pos.y += step;
        });
    }

    function wrappedTitleLink(doc, pos, title, link, cfg) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(cfg.title);
        const color = link ? ACCENT : DARK;
        doc.setTextColor(color[0], color[1], color[2]);
        const lines = doc.splitTextToSize(title, CONTENT_W);
        const step = lh(cfg.title, 1.22);
        lines.forEach((line) => {
            checkPageBreak(doc, pos, step);
            if (link) {
                doc.textWithLink(line, MARGIN, pos.y, { url: link });
            } else {
                doc.text(line, MARGIN, pos.y);
            }
            pos.y += step;
        });
    }

    // ---------------------------------------------------------------------
    // Section renderers
    // ---------------------------------------------------------------------

    function renderHeader(doc, pos, data, cfg) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(cfg.name);
        doc.setTextColor(DARK[0], DARK[1], DARK[2]);
        doc.text(data.about.name || 'Curriculum Vitae', MARGIN, pos.y);
        pos.y += lh(cfg.name, 1.05);

        const latestJob = data.experience[0];
        if (latestJob) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(cfg.tagline);
            doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
            doc.text(`${latestJob.title} — ${latestJob.subheading}`, MARGIN, pos.y);
            pos.y += lh(cfg.tagline, 1.2);
        }

        pos.y += 1;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(cfg.small);

        const items = [];
        if (data.about.locationPhone) items.push({ text: data.about.locationPhone, color: MUTED });
        if (data.about.email) items.push({ text: data.about.email, url: `mailto:${data.about.email}`, color: ACCENT });
        data.about.socials.forEach((url) => items.push({ text: displayUrl(url), url, color: ACCENT }));

        const sep = '    |    ';
        let x = MARGIN;
        items.forEach((item, i) => {
            checkPageBreak(doc, pos, lh(cfg.small));
            if (x > PAGE_W - MARGIN - 40) {
                pos.y += lh(cfg.small, 1.3);
                x = MARGIN;
            }
            doc.setTextColor(item.color[0], item.color[1], item.color[2]);
            if (item.url) {
                doc.textWithLink(item.text, x, pos.y, { url: item.url });
            } else {
                doc.text(item.text, x, pos.y);
            }
            x += doc.getTextWidth(item.text);
            if (i < items.length - 1) {
                doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
                doc.text(sep, x, pos.y);
                x += doc.getTextWidth(sep);
            }
        });
        pos.y += lh(cfg.small, 1.3) + cfg.afterHeaderGap;

        doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
        doc.setLineWidth(0.8);
        doc.line(MARGIN, pos.y, PAGE_W - MARGIN, pos.y);
        pos.y += cfg.afterHeaderGap;
    }

    function renderSummary(doc, pos, text, cfg) {
        if (!text) return;
        sectionHeader(doc, pos, 'Profile', cfg);
        paragraph(doc, pos, text, { size: cfg.body, gapAfter: cfg.entryGap });
    }

    function renderSkills(doc, pos, skills, cfg) {
        if (!skills.length) return;
        sectionHeader(doc, pos, 'Skills', cfg);
        bulletList(doc, pos, skills, cfg);
        pos.y += cfg.entryGap;
    }

    function renderExperience(doc, pos, entries, cfg) {
        if (!entries.length) return;
        sectionHeader(doc, pos, 'Experience', cfg);
        entries.forEach((entry, idx) => {
            entryHeaderLine(doc, pos, entry.title, entry.date, cfg);
            subheadingLine(doc, pos, entry.subheading, cfg);
            pos.y += 0.8;
            entry.intro.forEach((p) => paragraph(doc, pos, p, { size: cfg.body }));
            if (entry.bullets.length) bulletList(doc, pos, entry.bullets, cfg);
            if (idx < entries.length - 1) pos.y += cfg.entryGap;
        });
        pos.y += cfg.entryGap;
    }

    function renderEducation(doc, pos, entries, cfg) {
        if (!entries.length) return;
        sectionHeader(doc, pos, 'Education', cfg);
        entries.forEach((entry, idx) => {
            entryHeaderLine(doc, pos, entry.title, entry.date, cfg);
            subheadingLine(doc, pos, entry.subheading, cfg);
            pos.y += 0.8;
            entry.lines.forEach((l) => paragraph(doc, pos, l, { size: cfg.body }));
            if (idx < entries.length - 1) pos.y += cfg.entryGap;
        });
        pos.y += cfg.entryGap;
    }

    function renderAbroad(doc, pos, entries, cfg) {
        if (!entries.length) return;
        sectionHeader(doc, pos, 'Studies and Experiences Abroad', cfg);
        entries.forEach((entry, idx) => {
            entryHeaderLine(doc, pos, entry.title, entry.date, cfg);
            subheadingLine(doc, pos, entry.institution, cfg);
            pos.y += 0.8;
            paragraph(doc, pos, entry.description, { size: cfg.body });
            if (idx < entries.length - 1) pos.y += cfg.entryGap;
        });
        pos.y += cfg.entryGap;
    }

    function renderConfs(doc, pos, entries, cfg) {
        if (!entries.length) return;
        sectionHeader(doc, pos, 'Conferences and Seminars', cfg);
        entries.forEach((entry, idx) => {
            wrappedTitleLink(doc, pos, entry.title, entry.link, cfg);
            subheadingLine(doc, pos, entry.subheading, cfg, entry.date);
            pos.y += 0.8;
            paragraph(doc, pos, entry.description, { size: cfg.body });
            if (idx < entries.length - 1) pos.y += cfg.entryGap;
        });
        pos.y += cfg.entryGap;
    }

    function renderPublications(doc, pos, entries, cfg, opts) {
        if (!entries.length) return;
        sectionHeader(doc, pos, opts && opts.title ? opts.title : 'Publications', cfg);
        entries.forEach((entry, idx) => {
            if (entry.kicker) {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(cfg.small);
                doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
                const label = entry.badge ? `${entry.kicker} — ${entry.badge}` : entry.kicker;
                checkPageBreak(doc, pos, lh(cfg.small));
                doc.text(label.toUpperCase(), MARGIN, pos.y);
                pos.y += lh(cfg.small, 1.15);
            }
            wrappedTitleLink(doc, pos, entry.title, entry.link, cfg);
            subheadingLine(doc, pos, entry.subheading, cfg, entry.date);
            pos.y += 0.8;
            if (!opts || !opts.omitCitation) {
                paragraph(doc, pos, entry.citation, { size: cfg.body });
            }
            if (idx < entries.length - 1) pos.y += cfg.entryGap;
        });
        pos.y += cfg.entryGap;
    }

    function renderFooterNote(doc, pos, pageUrl, cfg) {
        checkPageBreak(doc, pos, 10);
        doc.setDrawColor(200, 200, 200);
        doc.setLineWidth(0.2);
        doc.line(MARGIN, pos.y, PAGE_W - MARGIN, pos.y);
        pos.y += 5;
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(cfg.small);
        doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
        const prefix = 'Full CV and complete publication list available online:';
        doc.text(prefix, MARGIN, pos.y);
        const prefixWidth = doc.getTextWidth(prefix) + 1.3;
        doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
        doc.textWithLink(displayUrl(pageUrl), MARGIN + prefixWidth, pos.y, { url: pageUrl });
    }

    function addPageNumbers(doc) {
        const total = doc.internal.getNumberOfPages();
        if (total <= 1) return;
        for (let i = 1; i <= total; i++) {
            doc.setPage(i);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(150, 150, 150);
            doc.text(`${i} / ${total}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
        }
    }

    // ---------------------------------------------------------------------
    // Document builders
    // ---------------------------------------------------------------------

    function buildFullCv(data) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        doc.setProperties({
            title: `${data.about.name} - CV`,
            subject: 'Curriculum Vitae',
            author: data.about.name,
        });

        const cfg = {
            name: 20,
            tagline: 12,
            section: 12.5,
            title: 11,
            small: 9,
            body: 9.5,
            entryGap: 3.5,
            afterSectionGap: 5,
            afterHeaderGap: 4,
        };

        const pos = { y: MARGIN };
        renderHeader(doc, pos, data, cfg);
        renderSummary(doc, pos, data.about.paragraphs.join(' '), cfg);
        renderSkills(doc, pos, data.skills, cfg);
        renderExperience(doc, pos, data.experience, cfg);
        renderEducation(doc, pos, data.education, cfg);
        renderAbroad(doc, pos, data.abroad, cfg);
        renderConfs(doc, pos, data.confs, cfg);
        renderPublications(doc, pos, data.publications, cfg);
        renderFooterNote(doc, pos, data.pageUrl, cfg);

        addPageNumbers(doc);
        return doc;
    }

    function buildCompactCv(data) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        doc.setProperties({
            title: `${data.about.name} - CV (Compact)`,
            subject: 'Curriculum Vitae (Compact)',
            author: data.about.name,
        });

        const cfg = {
            name: 19,
            tagline: 11.5,
            section: 11.5,
            title: 10.5,
            small: 9,
            body: 9.5,
            entryGap: 3.2,
            afterSectionGap: 4,
            afterHeaderGap: 4,
        };

        const experience = data.experience.filter((e) => e.compact).map((e) => ({
            ...e,
            intro: [],
            bullets: e.bullets.slice(0, 2).map((b) => shorten(b, 150)),
        }));
        const education = data.education.filter((e) => e.compact).map((e) => ({
            ...e,
            lines: e.lines.filter((l) => /thesis/i.test(l) === false).slice(0, 1),
        }));
        const publications = data.publications.filter((p) => p.compact);

        const pos = { y: MARGIN };
        renderHeader(doc, pos, data, cfg);
        renderSummary(doc, pos, shorten(data.about.paragraphs[0] || '', 420), cfg);
        renderExperience(doc, pos, experience, cfg);
        renderEducation(doc, pos, education, cfg);
        renderSkills(doc, pos, data.skills, cfg);
        renderPublications(doc, pos, publications, cfg, { title: 'Selected Publications', omitCitation: true });
        renderFooterNote(doc, pos, data.pageUrl, cfg);

        return doc;
    }

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    function fileSafe(name) {
        return (name || 'CV').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    // jsPDF (~360KB) is only ever needed by someone who actually clicks a
    // download button, so it's loaded on demand here rather than on every
    // page view — most visitors just read the resume and never need it.
    // Loaded from the local vendored copy (js/vendor/jspdf.umd.min.js), not
    // a CDN, so the buttons keep working offline / without a third party.
    let jsPdfLoadPromise = null;
    function loadJsPdf() {
        if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
        if (jsPdfLoadPromise) return jsPdfLoadPromise;
        jsPdfLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'js/vendor/jspdf.umd.min.js';
            script.onload = () => resolve();
            script.onerror = () => {
                jsPdfLoadPromise = null;
                reject(new Error('load failed'));
            };
            document.head.appendChild(script);
        });
        return jsPdfLoadPromise;
    }

    async function generate(compact, btn) {
        const originalLabel = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = btn.innerHTML.replace(/Download/, 'Preparing');
        }
        try {
            await loadJsPdf();
        } catch (err) {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalLabel;
            }
            alert('PDF generation library failed to load. Please check your internet connection and try again.');
            return;
        }
        try {
            const data = gatherData();
            const doc = compact ? buildCompactCv(data) : buildFullCv(data);
            const base = fileSafe(data.about.name) || 'CV';
            doc.save(compact ? `${base}_CV_Compact.pdf` : `${base}_CV_Full.pdf`);
        } catch (err) {
            console.error('CV PDF generation failed:', err);
            alert('Something went wrong while generating the PDF. Please try again.');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalLabel;
            }
        }
    }

    window.addEventListener('DOMContentLoaded', () => {
        const fullBtn = document.getElementById('downloadFullCv');
        const compactBtn = document.getElementById('downloadCompactCv');
        if (fullBtn) fullBtn.addEventListener('click', () => generate(false, fullBtn));
        if (compactBtn) compactBtn.addEventListener('click', () => generate(true, compactBtn));
    });
})();
