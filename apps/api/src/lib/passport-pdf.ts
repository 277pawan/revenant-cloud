import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { RecoveryPassportDocument } from "../services/recovery-passport.service.js";

const VERIFY_LOGO_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../assets/revenant_verify_logo.png"
);
const LOGO_ASPECT = 2170 / 725;

const NAVY = "#0b1f33";
const INK = "#0f172a";
const MUTED = "#64748b";
const PASS = "#059669";
const FAIL = "#dc2626";
const WARN = "#d97706";

export function renderPassportPdf(input: {
  passport: RecoveryPassportDocument;
  organizationName: string;
}): Promise<Buffer> {
  const { passport, organizationName } = input;
  const verified = passport.result === "VERIFIED";

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: `Recovery passport — ${passport.system}`,
        Author: "Revenant Cloud",
        Subject: "Signed recovery readiness passport",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 48;
    const pageW = doc.page.width;
    const right = pageW - 48;
    const contentW = right - left;

    doc.rect(0, 0, pageW, 92).fill(NAVY);
    doc.image(VERIFY_LOGO_PATH, left, 22, { fit: [52 * LOGO_ASPECT, 52] });
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("Recovery passport", left, 72);
    doc
      .fillColor(verified ? PASS : FAIL)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(passport.result, left, 38, { width: contentW, align: "right" });

    doc.y = 116;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(passport.system, left);
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(11).fillColor(MUTED).text(organizationName);

    doc.moveDown(1);
    const boxY = doc.y;
    const meta = [
      ["Readiness", `${passport.readinessScore}/100`],
      ["Status", passport.readinessStatus],
      ["RTO", formatPair(passport.rto.actualSeconds, passport.rto.targetSeconds, passport.rto.pass)],
      ["RPO", formatPair(passport.rpo.observedSeconds, passport.rpo.targetSeconds, passport.rpo.pass)],
    ];
    doc.roundedRect(left, boxY, contentW, 72, 8).fill("#f8fafc");
    const colW = contentW / 4;
    meta.forEach(([label, value], i) => {
      const x = left + 12 + i * colW;
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label, x, boxY + 14, { width: colW - 8 });
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(value, x, boxY + 28, { width: colW - 8 });
    });

    doc.y = boxY + 88;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("Dimensions", left);
    doc.moveDown(0.4);

    for (const dim of passport.dimensions) {
      const color = dim.status === "pass" ? PASS : dim.status === "fail" ? FAIL : WARN;
      doc.fillColor(color).font("Helvetica-Bold").fontSize(9).text(`• ${dim.label}`, left, doc.y, {
        continued: true,
      });
      doc.fillColor(MUTED).font("Helvetica").text(` — ${dim.detail ?? dim.status}`);
      doc.moveDown(0.35);
    }

    if (passport.risks.length > 0) {
      doc.moveDown(0.5);
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("Open risks", left);
      doc.moveDown(0.3);
      for (const risk of passport.risks.slice(0, 6)) {
        doc.fillColor(WARN).font("Helvetica").fontSize(9).text(`• ${risk.message}`, left, doc.y, {
          width: contentW,
        });
        doc.moveDown(0.25);
      }
    }

    doc.moveDown(1);
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("INTEGRITY", left);
    doc.font("Courier").fontSize(7.5).fillColor(INK).text(passport.integrity.hash, left, doc.y + 2, {
      width: contentW,
    });
    doc.moveDown(0.8);
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
      `Signed ${passport.integrity.signedAt} · Job ${passport.jobId}`,
      left,
      doc.y,
      { width: contentW }
    );
    doc.image(VERIFY_LOGO_PATH, left, doc.y + 12, { fit: [120, 36] });

    doc.end();
  });
}

function formatPair(actual: number | null, target: number | null, pass: boolean): string {
  const a = actual != null ? `${actual}s` : "—";
  const t = target != null ? `${target}s` : "—";
  return `${a} / ${t} ${pass ? "✓" : "✗"}`;
}
