export function buildTrendData(days) {
  const tickers = new Map();
  const themes = new Map();

  for (const day of days) {
    for (const ticker of day.tickers ?? []) {
      const current = tickers.get(ticker.symbol) ?? {
        symbol: ticker.symbol,
        mentions: 0,
        days: new Set(),
        sources: new Set(),
        notes: [],
        latestMove: null,
      };

      current.mentions += ticker.mentions;
      current.days.add(day.date);
      for (const source of ticker.sources ?? []) current.sources.add(source);
      current.notes.push(...(ticker.notes ?? []).map((note) => ({ date: day.date, note })));
      if (ticker.latestMove) current.latestMove = ticker.latestMove;
      tickers.set(ticker.symbol, current);
    }

    for (const theme of day.themes ?? []) {
      const current = themes.get(theme.name) ?? {
        name: theme.name,
        mentions: 0,
        days: new Set(),
        sources: new Set(),
      };

      current.mentions += theme.mentions;
      current.days.add(day.date);
      for (const source of theme.sources ?? []) current.sources.add(source);
      themes.set(theme.name, current);
    }
  }

  return {
    tickers: [...tickers.values()]
      .map((ticker) => ({
        ...ticker,
        days: [...ticker.days],
        sources: [...ticker.sources],
        notes: ticker.notes.slice(-5),
      }))
      .sort((a, b) => b.days.length - a.days.length || b.mentions - a.mentions)
      .slice(0, 20),
    themes: [...themes.values()]
      .map((theme) => ({
        ...theme,
        days: [...theme.days],
        sources: [...theme.sources],
      }))
      .sort((a, b) => b.days.length - a.days.length || b.mentions - a.mentions),
  };
}

export function buildSwingPlan(latest, trendData) {
  const candidates = latest.candidates ?? [];
  const tickerMemory = new Map((trendData.tickers ?? []).map((ticker) => [ticker.symbol, ticker]));
  const macroTone = latest.macro?.tone ?? "Mixed";
  const ranked = candidates
    .filter((candidate) => candidate.stance !== "Low Priority")
    .slice(0, 10)
    .map((candidate) => {
      const memory = tickerMemory.get(candidate.symbol);
      const setup = classifySwingSetup(candidate, memory, macroTone);
      const quality = scoreSetupQuality(candidate, setup, memory, macroTone);

      return {
        symbol: candidate.symbol,
        setup,
        quality,
        timeframe: setup.timeframe,
        trigger: buildTrigger(candidate, setup),
        stop: buildStop(candidate, setup),
        target: buildTarget(setup),
        sizing: buildSizingGuidance(quality, macroTone),
        avoid: buildAvoidRule(candidate, setup, macroTone),
        checklist: buildTradeChecklist(candidate, setup, macroTone),
      };
    });

  return {
    ranked,
    bySymbol: new Map(ranked.map((item) => [item.symbol, item])),
    strategies: [
      {
        name: "Trend Pullback",
        use: "Strong ticker or theme that pauses into support instead of chasing a stretched open.",
        confirms: ["Higher low", "20-day or prior breakout support holds", "volume dries up on the pullback"],
      },
      {
        name: "Breakout",
        use: "Price clears a well-tested resistance level or flag with expanding volume.",
        confirms: ["Close above resistance", "above-average volume", "old resistance becomes support"],
      },
      {
        name: "Catalyst Continuation",
        use: "Fresh earnings, guidance, deal, recommendation, or sector catalyst with broad tape support.",
        confirms: ["holds opening range", "relative strength versus SPY/QQQ", "no near-term event trap"],
      },
      {
        name: "Reversal Bounce",
        use: "Oversold or beaten-down name only after buyers defend a clear level.",
        confirms: ["failed breakdown", "RSI or momentum turns up", "tight stop below the reversal low"],
      },
    ],
  };
}

function classifySwingSetup(candidate, memory, macroTone) {
  const text = [
    candidate.evidence,
    candidate.nextCheck,
    ...(candidate.positives ?? []),
    ...(candidate.risks ?? []),
    ...(candidate.sources ?? []),
  ]
    .join(" ")
    .toLowerCase();

  if (candidate.stance === "Risk Watch" || /lawsuit|investigation|antitrust|sell-off|downgraded|lowered|broken/.test(text)) {
    return {
      name: "Risk Watch",
      bias: "Wait",
      timeframe: "No trade until reaction stabilizes",
      risk: "headline or execution overhang",
    };
  }

  if (/surge|jump|rally|breakout|record high|all-time high|top mover|higher open/.test(text)) {
    return {
      name: "Breakout / Momentum",
      bias: macroTone === "Risk-Off" ? "Selective long" : "Long watch",
      timeframe: "2-10 trading days",
      risk: "false breakout or gap fade",
    };
  }

  if (/earnings|guidance|profit outlook|deal|acquir|contract|recommendation|recommended|new stock/.test(text)) {
    return {
      name: "Catalyst Continuation",
      bias: macroTone === "Risk-Off" ? "Starter-size long" : "Long watch",
      timeframe: "3-15 trading days",
      risk: "catalyst already priced in",
    };
  }

  if (/down|pulled back|oversold|ytd|weak|underwhelming/.test(text)) {
    return {
      name: "Reversal Bounce",
      bias: "Conditional long",
      timeframe: "2-7 trading days",
      risk: "catching a falling move before support forms",
    };
  }

  if ((memory?.days?.length ?? 0) >= 2) {
    return {
      name: "Trend Pullback",
      bias: macroTone === "Risk-Off" ? "Watch for support" : "Long watch",
      timeframe: "5-20 trading days",
      risk: "trend loses sponsorship",
    };
  }

  return {
    name: "Research Watch",
    bias: "Wait for chart confirmation",
    timeframe: "Build watchlist first",
    risk: "insufficient setup evidence",
  };
}

function scoreSetupQuality(candidate, setup, memory, macroTone) {
  let score = Math.round(candidate.score * 0.55);
  if (candidate.stance === "Buy Candidate") score += 18;
  if (candidate.stance === "Setup Watch") score += 10;
  if ((memory?.days?.length ?? 0) >= 2) score += 8;
  if ((candidate.sourceProfiles ?? []).length > 1) score += 5;
  if (setup.name === "Risk Watch") score -= 25;
  if (macroTone === "Risk-Off") score -= 10;
  if (macroTone === "Risk-On") score += 6;
  return clamp(score, 0, 100);
}

function buildTrigger(candidate, setup) {
  if (setup.name === "Breakout / Momentum") return "Enter only on a hold above the breakout or opening-range high with volume confirmation.";
  if (setup.name === "Catalyst Continuation") return "Enter after the catalyst move holds support and shows relative strength versus SPY or QQQ.";
  if (setup.name === "Reversal Bounce") return "Enter only after a higher low or failed breakdown confirms buyers are defending support.";
  if (setup.name === "Trend Pullback") return "Enter near rising short-term support after the pullback stops making lower lows.";
  if (setup.name === "Risk Watch") return "No long trigger until the headline risk is absorbed and price reclaims support.";
  return candidate.nextCheck ?? "Wait for price, volume, and source confirmation.";
}

function buildStop(_candidate, setup) {
  if (setup.name === "Breakout / Momentum") return "Initial stop below old resistance or the breakout-day low.";
  if (setup.name === "Catalyst Continuation") return "Initial stop below the catalyst support level or the prior session low.";
  if (setup.name === "Reversal Bounce") return "Initial stop below the reversal low; skip if that makes risk too wide.";
  if (setup.name === "Trend Pullback") return "Initial stop below the pullback low or key moving-average support.";
  if (setup.name === "Risk Watch") return "Define risk first; avoid loose stops around unresolved headline volatility.";
  return "Use the nearest invalidation level, not an arbitrary percentage.";
}

function buildTarget(setup) {
  if (setup.name === "Breakout / Momentum") return "First target at measured move or next resistance; consider partial profits into strength.";
  if (setup.name === "Catalyst Continuation") return "First target near prior swing high or 2R; trail only if volume confirms.";
  if (setup.name === "Reversal Bounce") return "First target near gap fill, 20-day average, or prior resistance.";
  if (setup.name === "Trend Pullback") return "First target at prior high; stretch target only if breadth and volume improve.";
  if (setup.name === "Risk Watch") return "No upside target until the risk event clears.";
  return "Require at least 2:1 reward-to-risk before considering the idea actionable.";
}

function buildSizingGuidance(quality, macroTone) {
  if (quality >= 80 && macroTone !== "Risk-Off") return "Normal planned risk if trigger/stop/target are all defined.";
  if (quality >= 60) return "Starter size; add only after confirmation.";
  return "Watchlist only or very small probe; quality is not strong enough for full risk.";
}

function buildAvoidRule(candidate, setup, macroTone) {
  if (setup.name === "Risk Watch") return "Avoid until the news overhang has a clear price response.";
  if (macroTone === "Risk-Off") return "Avoid chasing gaps; require broad-index confirmation first.";
  if ((candidate.risks ?? []).some((risk) => risk !== "no major risk flag found in current sources")) return "Avoid if the named risk is the dominant reason for today's move.";
  return "Avoid if entry would sit far above support or below the minimum reward-to-risk threshold.";
}

function buildTradeChecklist(candidate, setup, macroTone) {
  const checks = [
    "Direction: trade with the stock's short-term trend or wait for a confirmed reversal.",
    "Entry: mark the exact breakout, pullback, or opening-range level before the order.",
    "Stop: place invalidation at support/resistance, not at a comfort number.",
    "Target: require at least 2R or a nearby technical target before entry.",
  ];

  if (setup.name !== "Risk Watch") checks.push("Volume: prefer above-average participation on the trigger day.");
  if (macroTone === "Risk-Off") checks.push("Tape: reduce size unless SPY/QQQ and sector breadth confirm risk appetite.");
  if ((candidate.sourceProfiles ?? []).length <= 1) checks.push("Sources: find one more confirming source or chart signal before sizing up.");
  return checks;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
