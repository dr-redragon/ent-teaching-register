# ENT Teaching Register

Static website ready for GitHub Pages.

## Deploy

1. Create a new GitHub repository.
2. Upload all files from this folder.
3. Go to Settings → Pages.
4. Under 'Build and deployment':
   - Source: Deploy from a branch
   - Branch: main
   - Folder: /(root)
5. Save.

GitHub will publish the site at:
https://YOUR_USERNAME.github.io/REPOSITORY_NAME/
https://dr-redragon.github.io/ent-teaching-register/

## Notes

- Data is stored in the browser using localStorage.
- QR code functionality uses a public CDN.

## Academic years

The register year runs **August → July**. Each academic year (e.g. 2025/26 =
Aug 2025 – Jul 2026) gets its own tab and its own attendance table on the
Attendance panel, with percentages calculated from that year's sessions only.
"All years" stacks every year, one table each.

Reports can be generated for a single academic year or several at once — tick
the years in the Generate report dialog and choose whether to output a table
per year, one combined table, or both.
