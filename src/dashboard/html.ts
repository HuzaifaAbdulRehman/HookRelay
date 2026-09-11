const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes text for HTML.
 *
 * This is not decoration. Response snippets and header values are written by
 * whatever server the destination URL points at, and the delivery log renders
 * them, so an unescaped page would let a destination store script in this
 * dashboard.
 */
export function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Tagged template that escapes every interpolation. Use `raw()` to opt out deliberately. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, part, index) => {
    if (index === 0) return part;
    const value = values[index - 1];
    const rendered = value instanceof Raw ? value.value : escape(value);
    return out + rendered + part;
  }, '');
}

class Raw {
  constructor(readonly value: string) {}
}

/** Marks already-safe markup. Never call this on anything a destination produced. */
export function raw(value: string): Raw {
  return new Raw(value);
}

/**
 * Five greyscale levels, one accent, semantic status colours exempt from that
 * count. The ground is a stacked dark ramp rather than a flat void.
 */
const STYLES = `
  :root {
    color-scheme:dark;
    --ink:#f4f4f5; --muted:#b6b8c0; --faint:#848891; --line:#2b3038;
    --ground:#101214; --surface:#171b20; --surface-raised:#1c2127;
    --accent:#f0a82c; --accent-ink:#241807;
    --ok:#4ade80; --bad:#fb8b7d; --wait:#f5c451;
    --step-4:4px; --step-8:8px; --step-12:12px; --step-16:16px;
    --step-24:24px; --step-32:32px; --step-48:48px;
  }
  * { box-sizing:border-box; }
  body { min-height:100vh; margin:0; padding:var(--step-32); background-color:var(--ground);
         background-image:linear-gradient(#20252b 1px,transparent 1px),linear-gradient(90deg,#20252b 1px,transparent 1px);
         background-size:40px 40px; color:var(--ink); font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  main { max-width:68rem; margin:0 auto; }
  h1,h2 { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:-.05em; }
  h1 { font-size:clamp(32px,4vw,48px); line-height:.98; margin:0; font-weight:700; }
  .eyebrow { margin:0 0 var(--step-16); color:var(--accent); font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; }
  h2 { font:600 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); margin:var(--step-48) 0 var(--step-12); }
  .sub { color:var(--muted); margin:var(--step-12) 0 0; max-width:44rem; font-size:16px; }
  a { color:var(--accent); text-underline-offset:3px; }
  a:hover { text-decoration-thickness:2px; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:2px; }
  .topbar { display:flex; justify-content:space-between; align-items:center; padding:0 0 var(--step-24); border-bottom:1px solid var(--line); }
  .brand { display:flex; align-items:center; gap:var(--step-12); color:var(--ink); font-size:18px; font-weight:700; text-decoration:none; }
  .brand-mark { display:grid; place-items:center; width:44px; height:44px; border:1px solid #6f4b13; border-radius:8px; color:var(--accent); background:#2c2110; font:700 16px ui-monospace,monospace; }
  .system-status { color:var(--muted); font-size:14px; }
  .system-status::before { content:''; display:inline-block; width:8px; height:8px; margin-right:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px #2c2110; }
  .hero { padding:clamp(48px,7vh,72px) 0 var(--step-24); }
  .dashboard-head { padding:var(--step-48) 0 var(--step-24); }
  .dashboard-head h1 { font-size:40px; letter-spacing:-.04em; }
  .dashboard-head .sub { margin-top:var(--step-8); font-size:16px; }
  .panel { overflow:hidden; border:1px solid var(--line); border-radius:8px; background:var(--surface); }
  .panel + .panel { margin-top:var(--step-24); }
  .panel-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; padding:var(--step-16) var(--step-24); border-bottom:1px solid var(--line); }
  .panel-head h2 { margin:0; }
  .panel-body { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; font-variant-numeric:tabular-nums; min-width:640px; }
  th,td { text-align:left; padding:var(--step-12) var(--step-16); border-bottom:1px solid var(--line); vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  th { font-weight:600; color:var(--faint); font-size:10px; letter-spacing:.08em;
       text-transform:uppercase; }
  .mono { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.015em; }
  .badge { display:inline-block; padding:3px 9px; border-radius:999px; font-size:11px;
           font-weight:700; letter-spacing:.06em; border:1px solid currentColor; text-transform:uppercase; }
  .delivered { color:var(--ok); }
  .failed,.dlq { color:var(--bad); }
  .pending,.delivering { color:var(--wait); }
  .empty { display:flex; align-items:center; gap:var(--step-16); min-height:104px; margin:0; padding:var(--step-24); color:var(--muted); }
  .empty::before { content:'→'; display:grid; place-items:center; flex:0 0 auto; width:32px; height:32px; border:1px solid #6f4b13; border-radius:6px; color:var(--accent); font:700 16px/1 ui-monospace,monospace; }
  .empty p { margin:0; }
  .empty strong { display:block; color:var(--ink); font-weight:600; }
  .empty span { display:block; margin-top:var(--step-4); }
  button { font:700 14px/1 ui-sans-serif,system-ui,sans-serif; min-height:42px; padding:0 var(--step-16); border:1px solid #8d6218;
           border-radius:8px; background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  button:hover { filter:brightness(1.1); }
  .metadata { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; margin-top:var(--step-32); border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--line); }
  .metric { padding:var(--step-16); background:var(--surface-raised); }
  .metric strong { display:block; margin-top:var(--step-8); font:700 28px/1 ui-monospace,monospace; font-variant-numeric:tabular-nums slashed-zero; }
  .metric strong small { color:var(--muted); font:500 12px/1.2 ui-sans-serif,system-ui,sans-serif; }
  .metric span { color:var(--faint); font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
  .panel-meta { color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
  .destination,.ingest-path { display:block; max-width:290px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ingest-path { max-width:240px; }
  details.more { border-top:1px solid var(--line); }
  details.more summary { padding:12px var(--step-16); color:var(--accent); cursor:pointer; font-size:12px; }
  details.more summary::marker { color:var(--accent); }

  /* The one bold element, and it is drawn from what this service actually does:
     the retry ladder. Reading a row of attempt marks tells you the shape of a
     failing delivery faster than any table of numbers. */
  .ladder { display:flex; gap:var(--step-4); align-items:flex-end; height:28px; }
  .rung { width:10px; border-radius:2px; border:1px solid currentColor; }
  .rung-failed { color:var(--bad); background:color-mix(in srgb, var(--bad) 18%, transparent); }
  .rung-delivered { color:var(--ok); background:color-mix(in srgb, var(--ok) 22%, transparent); }
  .ladder-caption { color:var(--muted); font-size:12px; letter-spacing:.015em; margin-top:var(--step-8); }
  @media (max-width:640px) { body { padding:var(--step-16); } .metadata { grid-template-columns:repeat(2,1fr); } .topbar { padding-bottom:var(--step-16); } .system-status { font-size:0; } .system-status::before { margin:0; } .hero { padding-top:48px; } .dashboard-head { padding-top:32px; } .dashboard-head h1 { font-size:clamp(32px,10vw,40px); } .empty { align-items:flex-start; } }
`;

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · HookRelay</title><style>${STYLES}</style></head>
<body><main>
<nav class="topbar"><a class="brand" href="/dashboard"><span class="brand-mark">H</span>HookRelay</a><span class="system-status">Receiver online</span></nav>
${body}
</main></body></html>`;
}

export function badge(status: string): string {
  return `<span class="badge ${escape(status)}">${escape(status)}</span>`;
}

/**
 * The retry ladder as marks, one per attempt, growing with the backoff.
 *
 * The height is the point: an event that failed eight times shows a widening
 * staircase, so the shape of the backoff is visible without reading a single
 * timestamp. Status is carried by fill and by the label underneath, never by
 * colour alone.
 */
export function ladder(attempts: { attemptNumber: number; status: string }[]): string {
  if (attempts.length === 0) return '';

  const rungs = attempts
    .map((attempt, index) => {
      const height = 8 + Math.min(index, 7) * 3;
      const kind = attempt.status === 'delivered' ? 'delivered' : 'failed';
      return `<span class="rung rung-${kind}" style="height:${height}px" title="Attempt ${escape(
        attempt.attemptNumber,
      )}: ${escape(attempt.status)}"></span>`;
    })
    .join('');

  const delivered = attempts.filter((a) => a.status === 'delivered').length;
  const caption = `${attempts.length} attempt${attempts.length === 1 ? '' : 's'}, ${
    attempts.length - delivered
  } failed`;

  return `<div class="ladder" role="img" aria-label="${escape(caption)}">${rungs}</div>
<p class="ladder-caption">${escape(caption)}</p>`;
}
