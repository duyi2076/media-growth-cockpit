import crypto from "node:crypto";

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function contentDeliveryPayloadHash(value) {
  return sha256Json({
    version: 1,
    title: value.title,
    status: value.status,
    format: value.format,
    channels: value.channels,
    priority: value.priority,
    dueAt: value.dueAt,
    nextAction: value.nextAction,
    body: value.body.trim(),
    derivedFrom: value.derivedFrom,
    relatedAssets: value.relatedAssets,
    sourceRun: value.sourceRun,
    sourceTaskId: value.sourceTaskId,
    requestHash: value.requestHash,
  });
}

export function reviewDeliveryPayloadHash(value) {
  return sha256Json({
    version: 1,
    kind: value.kind,
    title: value.title,
    sourceUrl: value.sourceUrl,
    platform: value.platform,
    relatedContentId: value.relatedContentId,
    summary: value.summary,
    findings: value.findings,
    nextAction: value.nextAction,
    confirmation: value.confirmation,
    status: value.status,
    derivedFrom: value.derivedFrom,
    relatedAssets: value.relatedAssets,
    sourceRun: value.sourceRun,
    sourceTaskId: value.sourceTaskId,
    requestHash: value.requestHash,
  });
}
