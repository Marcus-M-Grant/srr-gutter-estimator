/**
 * Site configuration. Committed on purpose - there are no secrets here and
 * GitHub Pages can only serve files that are in the repo.
 *
 * TWO WAYS TO CONNECT THE SHEET. Pick one; see README "Connecting the sheet".
 *
 * 1. PUBLISHED CSV (recommended). The document stays private. You publish only
 *    the Web_Pricing and Web_Rules mirror tabs, which have Unit Cost and
 *    target_margin stripped out. Paste the two URLs below.
 *
 * 2. LINK SHARING (simpler, less private). Share the document as "Anyone with
 *    the link can view" and leave SHEET_ID set. Be aware this makes EVERY tab
 *    readable by anyone with the link, including Unit Cost on the Pricing tab
 *    and target_margin on the Rules tab.
 *
 * If neither is reachable the site runs off the committed /data snapshots and
 * says so in the footer. It never quotes a wrong number because of this.
 */

// Route 1 - published CSV. Fill these in and they win over SHEET_ID.
// File > Share > Publish to web > (pick the tab) > Comma-separated values (.csv)
export const PRICING_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSOsUOxJYaexYsKclO3AT5jCeNK4A9oFvLBsbNZta7V9LA2QqGyCK79nD8yjbud2cVN6lk-ms9PlKTt/pub?gid=531460638&single=true&output=csv';
export const RULES_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSOsUOxJYaexYsKclO3AT5jCeNK4A9oFvLBsbNZta7V9LA2QqGyCK79nD8yjbud2cVN6lk-ms9PlKTt/pub?gid=1580969290&single=true&output=csv';

// Route 2 - link sharing via the gviz endpoint. Reads the Web_* mirror tabs,
// never the raw Pricing/Rules tabs.
// Unused while the published-CSV URLs above are set, and kept only as a
// fallback route. The document itself stays private, so this id alone grants
// nobody access.
export const SHEET_ID = '1z8CM75Y2F5pTDn4EAZAa60b_io_aqSGOica2b4N5t-A';
