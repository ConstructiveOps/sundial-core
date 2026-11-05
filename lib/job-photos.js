// lib/job-photos.js — where a service job's photos live and how they are grouped
// (2026-09-18, moved here from sundial-service-board/tech.js on 2026-11-05).
//
// One folder per job: SUNDIAL/{jobId}/photos/{callId}/… for each visit, SUNDIAL/{jobId}/photos/…
// for what the office adds, SUNDIAL/{jobId}/photos/hcp/… for the Housecall Pro migration.
// The board Lambda's GET /service/jobs/{id}/photos and the estimate Lambda's photo report
// (D-072 amendment 17) both group a listing through groupJobPhotos, so the office sees the
// same groups in the photo picker as on the job page. Pure; no S3 here.

import { buildKey } from "./file-access.js";

/** The HCP migration's photo folder under a job (lib/hcp-media.js PHOTO_FOLDER). */
export const HCP_PHOTO_FOLDER = "hcp";
/** Photos live under the job, in a folder per call. */
export const photoPrefix = (jobId, callId) => `${buildKey(jobId, "photos")}/${callId}/`;
/** The job's whole photo folder — every call's, plus what the office dropped at the top. */
export const jobPhotoPrefix = (jobId) => `${buildKey(jobId, "photos")}/`;

/**
 * Group a job's photo listing by the call each one belongs to (2026-09-18). A key
 * directly under photos/ (no call folder) is the office's; the tech app and the job
 * page both show the groups, so a tech sees the other techs' photos on the same job.
 */
export function groupJobPhotos(photos, prefix, calls = []) {
  const byCall = new Map();
  for (const p of photos) {
    const rest = p.key.startsWith(prefix) ? p.key.slice(prefix.length) : p.fileName;
    const slash = rest.indexOf("/");
    const callId = slash > 0 ? rest.slice(0, slash) : null;
    const key = callId ?? "office";
    if (!byCall.has(key)) byCall.set(key, []);
    byCall.get(key).push({ ...p, fileName: slash > 0 ? rest.slice(slash + 1) : rest, callId });
  }
  const callInfo = new Map(calls.map((c) => [c.Id, c]));
  const groups = [...byCall.entries()].map(([key, list]) => {
    const c = key === "office" ? null : callInfo.get(key) ?? null;
    const tech = c?.Tech__r ? [c.Tech__r.First_Name__c, c.Tech__r.Last_Name__c].filter(Boolean).join(" ") : null;
    // `photos/hcp/` is the migration's pseudo-call (2026-10-05, lib/hcp-media.js): the
    // photos Harmon's techs took in Housecall Pro, shown as their own group, oldest.
    const migrated = key === HCP_PHOTO_FOLDER;
    return {
      callId: key === "office" ? null : key,
      callNumber: c?.Name ?? null,
      techName: tech,
      start: migrated ? "" : c?.Scheduled_Start__c ?? c?.Actual_Start__c ?? null,
      label: key === "office" ? "Office" : migrated ? "Housecall Pro" : [tech ?? "Visit", c?.Scheduled_Start__c ? new Date(c.Scheduled_Start__c).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null].filter(Boolean).join(" · "),
      photos: list.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified))),
    };
  });
  // Newest group first; the office's folder at the top when it has anything; the HCP group last.
  groups.sort((a, b) => (a.callId === null ? -1 : b.callId === null ? 1 : String(b.start ?? "").localeCompare(String(a.start ?? ""))));
  return groups;
}

