# ENT Teaching Register

Static website ready for GitHub Pages.

## Deploy

The site is published by GitHub Pages from `main`, at the custom domain:

**https://register.traineehq.com**

`CNAME` in the repository root is what tells GitHub Pages to serve the site
there. It must stay at the root and contain the bare hostname — no `https://`,
no trailing slash.

Settings → Pages is set to *Deploy from a branch*, branch `main`, folder
`/(root)`. Push to `main` and the site rebuilds.

See [docs/SETUP.md §5](docs/SETUP.md) for the DNS records, the order the
cutover has to happen in, and what to change in Supabase alongside it.

## Notes

- Data is stored in Supabase; see [docs/SETUP.md](docs/SETUP.md).
- QR code functionality uses a public CDN.

## Academic years

The register year runs **August → July**. Each academic year (e.g. 2025/26 =
Aug 2025 – Jul 2026) gets its own tab and its own attendance table on the
Attendance panel, with percentages calculated from that year's sessions only.
"All years" stacks every year, one table each.

Reports can be generated for a single academic year or several at once — tick
the years in the Generate report dialog and choose whether to output a table
per year, one combined table, or both.
