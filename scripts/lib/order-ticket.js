export function buildValidatedLongOrderPlan({ symbol, candle, livePrice = null }) {
  const reasons = [];

  if (!candle?.ok && !candle?.trigger) {
    return invalid("No fresh candle setup is available for order construction.");
  }

  const triggerText = String(candle?.trigger ?? "");
  const stopText = String(candle?.invalidation ?? "");
  const targetText = String(candle?.target ?? "");
  const setup = String(candle?.setup ?? "");
  const relativeStrength = String(candle?.relativeStrengthLabel ?? "");

  const triggerType = classifyTrigger(triggerText);
  const entry = extractFirstNumber(triggerText);
  const stop = extractFirstNumber(stopText);
  const target = extractFirstNumber(targetText);

  if (["Risk / Avoid", "Needs More Confirmation"].includes(setup)) {
    reasons.push(`Setup is ${setup}, so it is not ready for an executable order ticket.`);
  }

  if (["Lagging", "Laggard"].includes(relativeStrength)) {
    reasons.push(`Relative strength is ${relativeStrength}, so the setup is too weak for a long order ticket.`);
  }

  if (triggerType === "none") {
    reasons.push("Trigger text says there is no long trigger yet.");
  } else if (triggerType === "pullback_watch") {
    reasons.push("Trigger is only a pullback watch near support and does not provide an executable entry price.");
  }

  if (![entry, stop, target].every(Number.isFinite)) {
    reasons.push("Entry, stop, or target is not fully numeric.");
  }

  if (Number.isFinite(entry) && Number.isFinite(stop) && !(stop < entry)) {
    reasons.push("Protective stop is not below the proposed long entry.");
  }

  if (Number.isFinite(entry) && Number.isFinite(target) && !(target > entry)) {
    reasons.push("First target is not above the proposed long entry.");
  }

  if (Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(target)) {
    const rr = (target - entry) / (entry - stop);
    if (!Number.isFinite(rr) || rr < 2) {
      reasons.push(`Reward-to-risk is only ${round(rr)}R, below the 2R minimum.`);
    }
  }

  if (Number.isFinite(livePrice) && Number.isFinite(target) && livePrice >= target * 0.995) {
    reasons.push("Live price is already at or above the first target, so the setup is stale.");
  }

  if (Number.isFinite(livePrice) && Number.isFinite(entry) && triggerType !== "pullback_limit" && livePrice >= entry * 0.995) {
    reasons.push("Live price is already at or above the proposed entry, so a buy stop-limit would be stale or immediately triggered.");
  }

  if (reasons.length) return invalid(reasons[0], reasons);

  return {
    ok: true,
    style: "buy_stop_limit",
    symbol,
    entry,
    stop,
    target,
    reasons: [],
  };
}

function invalid(reason, reasons = [reason]) {
  return {
    ok: false,
    reason,
    reasons,
  };
}

function classifyTrigger(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized || /no long trigger yet/.test(normalized)) return "none";
  if (/watch for support near .*higher low/.test(normalized)) return "pullback_watch";
  if (/buy only above|enter only if|stays above|reclaim|follow-through volume|break and hold above/.test(normalized)) return "breakout_confirmation";
  return "generic_numeric";
}

function extractFirstNumber(text) {
  const normalized = String(text ?? "").replace(/\b\d+(?:\.\d+)?:1\b/g, " ");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
}
