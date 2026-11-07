import { toDay } from "./dates";

/**
 * Uploaded filenames can carry a child's name, date of birth, or member ID ("Smith_Jane_DOB...
 * .xlsm"). They are never stored or logged: an upload is shown by a neutral name built from what
 * it is, its file type, and the upload day, e.g. "VB-MAPP workbook (.xlsm), uploaded 2026-11-07".
 * Assessment score files follow the same rule (storedImportName in services/assessment-imports.ts).
 */
export function neutralUploadName(kind: string, filename: string, uploadedAt: Date = new Date()): string {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1] ?? "").toLowerCase();
  return `${kind}${ext ? ` (.${ext})` : ""}, uploaded ${toDay(uploadedAt)}`;
}
