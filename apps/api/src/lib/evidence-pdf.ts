import PDFDocument from "pdfkit";
import type { JobDetailResource } from "@revenant/shared";

const NAVY = "#0b1f33";
const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#e2e8f0";
const PASS = "#059669";
const FAIL = "#dc2626";
const WARN = "#d97706";
const BRAND = "#2563eb";

export interface EvidencePdfInput {
  job: JobDetailResource;
  organizationName: string;
  sha256: string;
  archivedAt?: string;
}

function statusColor(status: string): string {
  if (status === "pass") return PASS;
  if (status === "fail") return FAIL;
  return WARN;
}

function formatRto(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function renderEvidencePdf(input: EvidencePdfInput): Promise<Buffer> {
  const { job, organizationName, sha256, archivedAt } = input;
  const verdict = String(job.status).toUpperCase();
  const accent = statusColor(String(job.status));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: `Revenant restore evidence — ${job.databaseName}`,
        Author: "Revenant Cloud",
        Subject: "Disaster recovery evidence certificate",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const left = 48;
    const right = pageW - 48;
    const contentW = right - left;

    doc.rect(0, 0, pageW, 92).fill(NAVY);

    doc
      .circle(left + 18, 46, 18)
      .fill("#ffffff");
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor(NAVY)
      .text("R", left, 36, { width: 36, align: "center" });

    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("REVENANT", left + 48, 28);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#94a3b8")
      .text("Restore evidence certificate", left + 48, 52);

    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(accent)
      .text(verdict, left, 36, { width: contentW, align: "right" });

    doc.y = 116;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20);
    doc.text(job.databaseName, left, doc.y, { width: contentW });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(11).fillColor(MUTED);
    doc.text(organizationName, left, doc.y, { width: contentW });

    doc.moveDown(1.1);
    const boxY = doc.y;
    const boxH = 78;
    doc.roundedRect(left, boxY, contentW, boxH, 8).fill("#f8fafc");
    doc.roundedRect(left, boxY, 4, boxH, 0).fill(accent);

    const colW = contentW / 4;
    const meta = [
      ["Outcome", verdict],
      ["RTO", formatRto(job.rtoSeconds)],
      ["Trigger", String(job.trigger)],
      ["Mode", job.executionMode ? String(job.executionMode) : "—"],
    ];
    meta.forEach((pair, i) => {
      const x = left + 16 + i * colW;
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(pair[0], x, boxY + 16, {
        width: colW - 12,
      });
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(pair[1], x, boxY + 32, {
        width: colW - 12,
      });
    });

    doc.y = boxY + boxH + 22;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("Run details", left);
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);

    const details: Array<[string, string]> = [
      ["Job ID", job.id],
      ["Started", formatWhen(job.startedAt)],
      ["Finished", formatWhen(job.finishedAt)],
      ["Archived", formatWhen(archivedAt)],
    ];
    if (job.errorMessage) {
      details.push(["Error", job.errorMessage]);
    }

    details.forEach(([k, v]) => {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(k.toUpperCase(), left, doc.y);
      doc.fillColor(INK).font("Helvetica").fontSize(9).text(v, left + 90, doc.y - 11, {
        width: contentW - 90,
      });
      doc.moveDown(0.55);
    });

    doc.moveDown(0.4);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("Checks", left);
    doc.moveDown(0.35);

    const tableTop = doc.y;
    doc.rect(left, tableTop, contentW, 20).fill(NAVY);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    doc.text("Check", left + 8, tableTop + 6, { width: 150 });
    doc.text("Type", left + 160, tableTop + 6, { width: 80 });
    doc.text("Result", left + 250, tableTop + 6, { width: 50 });
    doc.text("Duration", left + 310, tableTop + 6, { width: 55 });
    doc.text("Message", left + 370, tableTop + 6, { width: contentW - 378 });

    let y = tableTop + 20;
    const rows = job.results ?? [];
    if (rows.length === 0) {
      doc.rect(left, y, contentW, 22).fill("#ffffff").stroke(LINE);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("No check rows recorded.", left + 8, y + 7);
      y += 22;
    }

    rows.forEach((r, idx) => {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 48;
      }
      const rowH = 26;
      doc.rect(left, y, contentW, rowH).fill(idx % 2 === 0 ? "#ffffff" : "#f8fafc");
      doc
        .moveTo(left, y + rowH)
        .lineTo(right, y + rowH)
        .strokeColor(LINE)
        .lineWidth(0.5)
        .stroke();

      doc.fillColor(INK).font("Helvetica").fontSize(8).text(r.checkName, left + 8, y + 8, {
        width: 148,
        ellipsis: true,
      });
      doc.fillColor(MUTED).text(r.checkType, left + 160, y + 8, { width: 78, ellipsis: true });
      doc
        .fillColor(statusColor(String(r.status)))
        .font("Helvetica-Bold")
        .text(String(r.status).toUpperCase(), left + 250, y + 8, { width: 50 });
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .text(r.durationMs != null ? `${r.durationMs} ms` : "—", left + 310, y + 8, {
          width: 55,
        });
      doc.fillColor(INK).text(r.message ?? "", left + 370, y + 8, {
        width: contentW - 378,
        ellipsis: true,
      });
      y += rowH;
    });

    doc.y = Math.max(y + 24, doc.page.height - 110);
    if (doc.y > doc.page.height - 100) {
      doc.addPage();
      doc.y = 48;
    }

    doc
      .moveTo(left, doc.y)
      .lineTo(right, doc.y)
      .strokeColor(LINE)
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.8);

    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("INTEGRITY (SHA-256)", left);
    doc
      .font("Courier")
      .fontSize(7.5)
      .fillColor(INK)
      .text(sha256, left, doc.y + 2, { width: contentW });

    doc.moveDown(1.2);
    doc.font("Helvetica").fontSize(8).fillColor(MUTED);
    doc.text(
      "Share this file yourself — Revenant does not publish a public link. Generated by Revenant Cloud for disaster-recovery evidence.",
      left,
      doc.y,
      { width: contentW }
    );
    doc.fillColor(BRAND).text("revenant", left, doc.y + 14);

    doc.end();
  });
}
