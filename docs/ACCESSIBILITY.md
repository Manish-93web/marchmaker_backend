# Accessibility

Target: WCAG 2.2 AA, mobile first, readable in Hindi and English, usable by keyboard and screen reader.

## Automated (runs in CI)

- **axe-core** checks on the busiest member pages (home, pricing, sign-in, create account, dashboard, billing, notifications and settings, invite and wallet, help, appeal, story, a guide) and console screens (insights, payments, moderation, experiments): names, roles, labels, landmarks, duplicate ids, ARIA misuse, table headers, link and button names. Colour contrast and region rules are switched off in jsdom (no layout) and covered below.
- `node scripts/contrast.mjs` (frontend repo) prints contrast ratios for every colour pair in both themes. **All pairs now meet AA**; the light-theme warning colour was darkened from `#c98a12` (2.95:1) to `#946200` (5.2:1).
- Playwright checks the skip link is the first tab stop.

Found and fixed by the automated checks: empty table header cells on the home comparison table and the notification settings table.

## Built in

- Visible focus rings; 44 px minimum touch targets; respects reduced motion; dark theme with checked contrast.
- Every form field has a label and a plain-language error (`role="alert"`); status messages use `role="status"` / `aria-live`.
- Dialogs and sheets are `role="dialog"`, labelled, closable with Escape, focus moved in on open.
- Charts have text alternatives (labelled SVG plus the numbers beside them); the funnel and tables are real lists and tables with captions and scoped headers.
- Audio has the full text beside it; nothing depends on sound, colour or hover alone.
- Notification copy and the introduction "why" are plain sentences, never scores.

## Manual pass before launch (tick in `LAUNCH_CHECKLIST.md`)

Automated tools find roughly a third of issues. Before launch, a person should:

1. Complete sign-up, an introduction (accept and decline), billing and a support ticket **using only the keyboard**, checking order, focus visibility and that nothing traps focus.
2. Repeat with **NVDA + Firefox/Chrome** (Windows) and **VoiceOver + Safari** (iPhone): are headings, landmarks, form errors and live regions announced sensibly?
3. Zoom to 200% and 400% (reflow) and increase text size to 200% on a phone.
4. Turn on reduced motion and high-contrast / forced-colours modes.
5. Read the Hindi strings for tone and truncation (when Hindi copy is added).
6. Try the console's tables and dialogs with a screen reader (internal tool, but staff may rely on assistive technology).

Record the date, tester and findings here.

| Date | Tester | Tool | Findings |
|---|---|---|---|
| (not yet done) | | | |
