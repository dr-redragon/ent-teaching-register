// Certificate PDF. Everything about how the certificate LOOKS lives in this file,
// so restyling it (or swapping in a different generator) is a contained change.
import { PDFDocument, StandardFonts, rgb, type PDFImage } from "https://esm.sh/pdf-lib@1.17.1?target=deno";

export interface CertificateInput {
  name: string;
  sessionTitle: string;
  sessionDate: string;   // ISO date, e.g. 2026-05-14
  location?: string | null;
  reference?: string | null;
  logoUrl?: string | null;         // overrides the bundled default logo when set
}

const INK = rgb(0.082, 0.129, 0.110);   // #15211c
const MOSS = rgb(0.247, 0.420, 0.310);  // #3f6b4f
const MOSS_DEEP = rgb(0.173, 0.302, 0.224);
const GOLD = rgb(0.690, 0.541, 0.243);  // #b08a3e
const PAPER = rgb(0.988, 0.980, 0.960);
const MUTED = rgb(0.478, 0.459, 0.408);

// Standard PDF fonts are WinAnsi-encoded; anything outside that range makes
// pdf-lib throw. Fold accents down rather than fail on a trainee's name.
function safe(text: string): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .trim();
}

function formatDate(iso: string): string {
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00Z" : ""));
  if (isNaN(d.getTime())) return safe(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// The North West ENT Regional Trainees Society badge, defaulting to wherever
// the site is published (the same convention APP_BASE_URL uses) so certificates
// carry the right branding with no configuration. CERT_LOGO_URL overrides it.
const DEFAULT_LOGO_URL =
  (Deno.env.get("APP_BASE_URL") || "https://dr-redragon.github.io/ent-teaching-register")
    .replace(/\/+$/, "") + "/assets/logo.png";

async function embedFromBytes(pdf: PDFDocument, bytes: Uint8Array): Promise<PDFImage | null> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (isPng) return await pdf.embedPng(bytes);
  if (isJpg) return await pdf.embedJpg(bytes);
  return null;                         // SVG and friends: convert to PNG first
}

async function loadLogo(pdf: PDFDocument, url: string | null | undefined): Promise<PDFImage | null> {
  try {
    const res = await fetch(url || DEFAULT_LOGO_URL);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return await embedFromBytes(pdf, bytes);
  } catch {
    return null;                       // a missing logo must never block a certificate
  }
}

export async function buildCertificatePdf(input: CertificateInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificate of Attendance - ${safe(input.name)}`);
  pdf.setCreator("ENT Regional Teaching Register");

  const page = pdf.addPage([842, 595]);            // A4 landscape
  const { width, height } = page.getSize();

  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const centre = (text: string, font: typeof serif, size: number, y: number, color = INK) => {
    const t = safe(text);
    page.drawText(t, { x: (width - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
  };

  page.drawRectangle({ x: 0, y: 0, width, height, color: PAPER });
  page.drawRectangle({ x: 26, y: 26, width: width - 52, height: height - 52, borderColor: MOSS, borderWidth: 2.5 });
  page.drawRectangle({ x: 34, y: 34, width: width - 68, height: height - 68, borderColor: GOLD, borderWidth: 0.9 });

  let cursor = height - 100;

  const logo = await loadLogo(pdf, input.logoUrl);
  if (logo) {
    const maxW = 170, maxH = 78;
    const scale = Math.min(maxW / logo.width, maxH / logo.height, 1);
    const w = logo.width * scale, h = logo.height * scale;
    page.drawImage(logo, { x: (width - w) / 2, y: cursor - h + 18, width: w, height: h });
    cursor -= h + 20;
  }

  centre("ENT REGIONAL TEACHING", sansBold, 11, cursor);
  cursor -= 48;
  centre("Certificate of Attendance", serifBold, 36, cursor, MOSS_DEEP);
  cursor -= 22;
  page.drawLine({
    start: { x: width / 2 - 90, y: cursor }, end: { x: width / 2 + 90, y: cursor },
    thickness: 1.4, color: GOLD,
  });

  cursor -= 52;
  centre("This is to certify that", serif, 14.5, cursor, MUTED);
  cursor -= 48;
  centre(input.name, serifBold, 32, cursor);
  cursor -= 38;
  centre("attended the regional teaching session", serif, 14.5, cursor, MUTED);
  cursor -= 38;
  centre(input.sessionTitle, sansBold, 18, cursor, MOSS_DEEP);
  cursor -= 30;
  const when = formatDate(input.sessionDate) + (input.location ? `  -  ${safe(input.location)}` : "");
  centre(when, sans, 13, cursor, MUTED);

  const footY = 62;
  page.drawLine({ start: { x: 70, y: footY + 20 }, end: { x: width - 70, y: footY + 20 }, thickness: 0.6, color: GOLD });
  page.drawText("Issued by the ENT Regional Teaching Programme", { x: 70, y: footY, size: 9.5, font: sans, color: MUTED });
  const ref = safe(input.reference || "");
  if (ref) {
    const t = `Ref ${ref}`;
    page.drawText(t, { x: width - 70 - sans.widthOfTextAtSize(t, 9.5), y: footY, size: 9.5, font: sans, color: MUTED });
  }

  return await pdf.save();
}
