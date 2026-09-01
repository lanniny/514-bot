// modules/delta-merge.js — Wave B slice 19
// 事件 delta 合并 + 字节会计：utf8 度量、驻留字节估算、delta 流去重/合并。
// 工厂 + DI：isDeltaEventType/NORMALIZED_EVENT_FIXED_OVERHEAD 从 app.js 注入。

export function createDeltaMerge({
  isDeltaEventType,
  NORMALIZED_EVENT_FIXED_OVERHEAD,
}) {
  const MERGED_DELTA_TRACKED_ID_LIMIT = 256;
  const runHistoryEventBytes = new WeakMap();
  const mergedDeltaEventIds = new WeakMap();
  const mergedDeltaSequenceRanges = new WeakMap();
  const runHistoryTextEncoder = new TextEncoder();

  function utf8Bytes(value) {
    return runHistoryTextEncoder.encode(String(value ?? "")).byteLength;
  }

  function estimateUiValueResidentBytes(value, depth = 0) {
    if (value == null) return 8;
    if (typeof value === "string") return value.length * 2 + 16;
    if (typeof value === "number" || typeof value === "boolean") return 16;
    if (depth >= 8) return 64;
    if (Array.isArray(value)) {
      let bytes = 32 + value.length * 8;
      for (const item of value) bytes += estimateUiValueResidentBytes(item, depth + 1);
      return bytes;
    }
    if (typeof value !== "object") return String(value).length * 2 + 16;
    let bytes = 64;
    for (const [key, item] of Object.entries(value)) {
      bytes += key.length * 2 + 24 + estimateUiValueResidentBytes(item, depth + 1);
    }
    return bytes;
  }

  function normalizedEventResidentBytes(event) {
    const known = runHistoryEventBytes.get(event);
    if (known != null) return known;
    const bytes = NORMALIZED_EVENT_FIXED_OVERHEAD + estimateUiValueResidentBytes(event);
    runHistoryEventBytes.set(event, bytes);
    return bytes;
  }

  function serializedRunHistoryEventBytes(event) {
    return normalizedEventResidentBytes(event);
  }

  function eventIdsForTracking(event) {
    const mergedIds = mergedDeltaEventIds.get(event);
    return mergedIds ? [...mergedIds] : [event?.id];
  }

  function eventTracksId(event, id) {
    if (!event || id == null) return false;
    return event.id === id || Boolean(mergedDeltaEventIds.get(event)?.has(id));
  }

  function eventSequenceRange(event) {
    const tracked = mergedDeltaSequenceRanges.get(event);
    if (tracked) return tracked;
    const sequence = Number(event?.seq);
    return Number.isSafeInteger(sequence) ? { min: sequence, max: sequence } : null;
  }

  function eventTracksEvent(tracked, incoming) {
    if (!tracked || !incoming) return false;
    if (eventIdsForTracking(incoming).some((id) => eventTracksId(tracked, id))) return true;
    if (!sameDeltaStream(tracked, incoming)) return false;
    const sequence = Number(incoming.seq);
    const range = eventSequenceRange(tracked);
    return Number.isSafeInteger(sequence) && Boolean(range && sequence >= range.min && sequence <= range.max);
  }

  function sameDeltaStream(left, right) {
    return Boolean(
      left
      && isDeltaEventType(right.type)
      && left.type === right.type
      && left.runId === right.runId
      && left.sessionId === right.sessionId
      && left.correlationId === right.correlationId
    );
  }

  function canMergeDeltaEvent(target, incoming) {
    if (!sameDeltaStream(target, incoming)) return false;
    const targetRange = eventSequenceRange(target);
    const incomingRange = eventSequenceRange(incoming);
    if (targetRange || incomingRange) {
      return Boolean(targetRange && incomingRange && incomingRange.min === targetRange.max + 1);
    }
    const trackedIds = mergedDeltaEventIds.get(target);
    const trackedCount = trackedIds?.size ?? (target?.id == null ? 0 : 1);
    const newIds = eventIdsForTracking(incoming)
      .filter((id) => id != null && !eventTracksId(target, id));
    return trackedCount + newIds.length <= MERGED_DELTA_TRACKED_ID_LIMIT;
  }

  function mergeDeltaEvent(target, incoming) {
    let mergedIds = mergedDeltaEventIds.get(target);
    if (!mergedIds) {
      mergedIds = new Set([target.id]);
      mergedDeltaEventIds.set(target, mergedIds);
    }
    for (const id of eventIdsForTracking(incoming)) {
      if (id != null) mergedIds.add(id);
    }
    while (mergedIds.size > MERGED_DELTA_TRACKED_ID_LIMIT) {
      mergedIds.delete(mergedIds.values().next().value);
    }
    const targetRange = eventSequenceRange(target);
    const incomingRange = eventSequenceRange(incoming);
    if (targetRange || incomingRange) {
      mergedDeltaSequenceRanges.set(target, {
        min: Math.min(targetRange?.min ?? incomingRange.min, incomingRange?.min ?? targetRange.min),
        max: Math.max(targetRange?.max ?? incomingRange.max, incomingRange?.max ?? targetRange.max),
      });
    }
    target.summary = `${target.summary}${incoming.summary}`.slice(-500);
    target.content = `${target.content}${incoming.content}`.slice(-4000);
    target.timestamp = incoming.timestamp;
    target.seq = incoming.seq;
  }

  function cacheRunHistoryEventBytes(event, bytes) {
    runHistoryEventBytes.set(event, bytes);
  }

  function cacheMergedDeltaEventIds(event, ids) {
    mergedDeltaEventIds.set(event, new Set(ids));
  }

  return {
    utf8Bytes,
    normalizedEventResidentBytes,
    serializedRunHistoryEventBytes,
    eventIdsForTracking,
    eventTracksEvent,
    canMergeDeltaEvent,
    mergeDeltaEvent,
    cacheRunHistoryEventBytes,
    cacheMergedDeltaEventIds,
  };
}
