// files-phase.js — the sample PDFs for the Files tabs (only with --with-files).
//
// Each file goes to the real key layout, SUNDIAL/{recordId}/{fileName} in the shared
// bucket (lib/file-access.js), with a sundial_file_metadata row in the shape every other
// writer uses (registerFileMetadata). Re-running overwrites the object and adds no second
// metadata row.
//
// Every page is stamped "SAMPLE - DEMO DATA" in large letters. No photos.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { buildKey, sanitizeFileName, registerFileMetadata, findFileMetadataByKey } from "../../lib/file-access.js";
import { SeedError } from "./writer.js";

/** One Letter page: a banner, the title, the lines. Plain ASCII only (the built-in fonts cannot draw more). */
export async function renderSamplePdf({ title, lines }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, "-");
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.85, 0.2, 0.15) });
  page.drawText("SAMPLE - DEMO DATA", { x: 40, y: 758, size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText(ascii(title), { x: 40, y: 700, size: 18, font: bold, color: rgb(0.1, 0.1, 0.1) });
  let y = 665;
  for (const line of lines) {
    // Wrap long lines at about 90 characters so nothing runs off the page.
    const words = ascii(line).split(" ");
    let row = "";
    for (const w of words) {
      if ((row + " " + w).length > 90) { page.drawText(row, { x: 40, y, size: 11, font: regular }); y -= 16; row = w; }
      else row = row ? `${row} ${w}` : w;
    }
    if (row) { page.drawText(row, { x: 40, y, size: 11, font: regular }); y -= 22; }
  }
  page.drawText("This document is fictional. It was generated for a product demonstration.", { x: 40, y: 60, size: 9, font: regular, color: rgb(0.4, 0.4, 0.4) });
  page.drawText("SAMPLE - DEMO DATA", { x: 120, y: 330, size: 40, font: bold, color: rgb(0.9, 0.9, 0.9), rotate: { type: "degrees", angle: 30 } });
  // A fixed creation date keeps the bytes (almost) the same from run to run.
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setTitle(ascii(title));
  return doc.save();
}

export async function runFilesPhase({ io, plan, writer, idmap, log, counters }) {
  const supabase = await io.getSupabase();
  const tenantId = writer.tenantId;
  for (const f of plan.files) {
    const recordId = writer.idOf(f.recordKey);
    const fileName = sanitizeFileName(f.fileName);
    const key = buildKey(recordId, fileName);
    let bytes = null;
    if (idmap.data.files[f.key] !== key) {
      bytes = await renderSamplePdf(f);
      try {
        await io.s3.putObject({ key, body: bytes, contentType: "application/pdf" });
      } catch (e) {
        throw new SeedError(`could not upload ${fileName}: ${e?.name || e?.message || "S3 error"}`, "S3_PUT");
      }
      counters.s3 = (counters.s3 || 0) + 1;
      idmap.data.files[f.key] = key;
      await idmap.save();
    }
    // The metadata row is best-effort everywhere else in Sundial; here a failure is reported.
    if (!(await findFileMetadataByKey(supabase, key))) {
      // A run that stopped between the upload and this row resumes here with no bytes in
      // hand. The PDF is generated from the plan alone, so it is simply generated again to
      // learn its size — the Files tab must never show a file of unknown size.
      bytes ??= await renderSamplePdf(f);
      try {
        await registerFileMetadata(supabase, {
          s3Key: key, fileName, tenantId, sfRecordId: recordId, sfObjectType: f.objectType,
          uploadedByUserId: null, uploadedByUserName: "Sundial demo seed", fileSizeBytes: bytes.byteLength,
          mimeType: "application/pdf", category: f.category, description: "SAMPLE - DEMO DATA", subfolder: null,
        });
        counters.supabase.sundial_file_metadata = (counters.supabase.sundial_file_metadata || 0) + 1;
      } catch (e) {
        throw new SeedError(`file metadata for ${fileName}: ${String(e?.message || e).slice(0, 200)}`, "SUPABASE_WRITE");
      }
    }
  }
  log(`  files: ${plan.files.length} sample PDF(s) in place`);
}
