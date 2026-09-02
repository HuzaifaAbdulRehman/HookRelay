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
 * count. Ink stops at #2A2A2A and the dark ground is a stacked ramp rather than
 * a flat void, because pure black on a lit screen reads as a hole.
 */
const STYLES = `
  :root {
    color-scheme: light dark;
    --ink:#2a2a2a; --muted:#5f6368; --faint:#8a8f96; --line:#e3e5e8;
    --ground:#fbfbfa; --surface:#ffffff;
    --accent:#1f6f5c;
    --ok:#1a6b3c; --bad:#a8392b; --wait:#7a5c00;
    --step-4:4px; --step-8:8px; --step-12:12px; --step-16:16px;
    --step-24:24px; --step-32:32px; --step-48:48px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink:#e2e8f0; --muted:#a6adb8; --faint:#7a828d; --line:#2e3238;
      --ground:#1b1d21; --surface:#212429;
      --accent:#6fbfa6;
      --ok:#5cc98a; --bad:#e8867a; --wait:#d4b155;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:var(--step-32) var(--step-24); background:var(--ground); color:var(--ink);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  main { max-width:64rem; margin:0 auto; }
  h1 { font-size:20px; line-height:1.3; letter-spacing:-0.015em; margin:0 0 var(--step-4); font-weight:600; }
  h2 { font-size:15px; margin:var(--step-32) 0 var(--step-12); font-weight:600; }
  .sub { color:var(--muted); margin:0 0 var(--step-24); }
  a { color:var(--accent); text-underline-offset:2px; }
  a:hover { text-decoration-thickness:2px; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:2px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums;
          background:var(--surface); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th,td { text-align:left; padding:var(--step-8) var(--step-12); border-bottom:1px solid var(--line); vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  th { font-weight:600; color:var(--faint); font-size:11px; letter-spacing:.015em;
       text-transform:uppercase; }
  .mono { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.015em; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px;
           font-weight:600; letter-spacing:.015em; border:1px solid currentColor; }
  .delivered { color:var(--ok); }
  .failed,.dlq { color:var(--bad); }
  .pending,.delivering { color:var(--wait); }
  .empty { color:var(--muted); padding:var(--step-32) 0; }
  button { font:inherit; min-height:40px; padding:0 var(--step-16); border:1px solid var(--line);
           border-radius:6px; background:var(--surface); color:var(--ink); cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  nav { margin-bottom:var(--step-24); font-size:13px; }

  /* The one bold element, and it is drawn from what this service actually does:
     the retry ladder. Reading a row of attempt marks tells you the shape of a
     failing delivery faster than any table of numbers. */
  .ladder { display:flex; gap:var(--step-4); align-items:flex-end; height:28px; }
  .rung { width:10px; border-radius:2px; border:1px solid currentColor; }
  .rung-failed { color:var(--bad); background:color-mix(in srgb, var(--bad) 18%, transparent); }
  .rung-delivered { color:var(--ok); background:color-mix(in srgb, var(--ok) 22%, transparent); }
  .ladder-caption { color:var(--muted); font-size:12px; letter-spacing:.015em; margin-top:var(--step-8); }
`;

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · HookRelay</title><style>${STYLES}</style></head>
<body><main>
<nav><a href="/dashboard">HookRelay</a></nav>
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
