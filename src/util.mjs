export function round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

export function truncate(s, n = 12000) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} chars truncated]` : s;
}

export function jsonText(v, n = 12000) {
  try { return truncate(JSON.stringify(v, null, 1), n); } catch { return truncate(String(v), n); }
}

export function compactPulse(p) {
  if (!p || p.ok === false) return p;
  return {
    url: p.url,
    title: p.title,
    seq: p.seq,
    viewport: p.viewport,
    last_change_age_ms: p.last_change_age_ms,
    age_ms: p.last_change_age_ms,
    status: p.status,
    focus: p.focus,
    countdown: p.countdown,
    timers: (p.timers || []).slice(0, 3),
    numbers: (p.numbers || []).slice(0, 6),
    dialogs: p.dialogs,
    alerts: p.alerts,
    media: p.media,
    t: p.t,
    ms: p.ms,
  };
}
