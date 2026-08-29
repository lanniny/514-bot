/**
 * Approval snapshot versioning.
 *
 * A runtime reload can leave an older GET response in flight.  Epoch alone
 * identifies the approval broker, while runtimeGeneration orders responses
 * across reloads.  This module keeps that ordering rule pure and testable.
 */

export function normalizeApprovalRuntimeGeneration(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function compareApprovalSnapshotVersions(current = {}, incoming = {}) {
  const currentEpoch = typeof current.epoch === "string" && current.epoch ? current.epoch : null;
  const incomingEpoch = typeof incoming.epoch === "string" && incoming.epoch ? incoming.epoch : null;
  const currentRevision = Number.isSafeInteger(current.revision) && current.revision >= 0 ? current.revision : 0;
  const incomingRevision = incoming.revision;
  const currentRuntimeGeneration = normalizeApprovalRuntimeGeneration(current.runtimeGeneration);
  const incomingRuntimeGeneration = normalizeApprovalRuntimeGeneration(incoming.runtimeGeneration);

  if (!incomingEpoch || !Number.isSafeInteger(incomingRevision) || incomingRevision < 0) {
    return { accepted: false, invalid: true, reason: "epoch/revision 无效" };
  }

  // Once a runtime anchor exists, an unanchored or older response cannot
  // replace it.  This is the critical reload boundary.
  if (currentRuntimeGeneration !== null && incomingRuntimeGeneration === null) {
    return { accepted: false, stale: true, reason: "缺少运行时代际" };
  }
  if (currentRuntimeGeneration !== null
    && incomingRuntimeGeneration !== null
    && incomingRuntimeGeneration < currentRuntimeGeneration) {
    return { accepted: false, stale: true, reason: "运行时代际已过期" };
  }

  let resetRevision = false;
  if (currentEpoch && incomingEpoch !== currentEpoch) {
    // A broker epoch may change only together with a strictly newer runtime.
    // Equal/unknown generations are indistinguishable from a stale response.
    if (currentRuntimeGeneration === null
      || incomingRuntimeGeneration === null
      || incomingRuntimeGeneration <= currentRuntimeGeneration) {
      return { accepted: false, stale: true, reason: "epoch 与运行时代际不一致" };
    }
    resetRevision = true;
  }

  if (!resetRevision && incomingRevision < currentRevision) {
    return { accepted: false, stale: true, reason: "revision 已过期" };
  }

  return {
    accepted: true,
    resetRevision,
    epoch: incomingEpoch,
    revision: incomingRevision,
    runtimeGeneration: incomingRuntimeGeneration,
  };
}
