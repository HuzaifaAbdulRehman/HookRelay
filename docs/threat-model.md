# Threat model: outbound delivery

HookRelay's whole job is to make an HTTP request to a URL somebody else chose. That is the
definition of server-side request forgery, so the question is not whether the SSRF surface
exists. It is what stops it reaching anything that matters.

## What an attacker gets

Someone who can create an endpoint controls `destination_url`. They can then read the delivery
log for that endpoint, which carries the response status, a truncated body and a duration. So
the primitive is: **make our server fetch an address of my choosing, and show me what came
back.**

The targets worth naming are cloud metadata services, because they hand out credentials to
anyone who can reach them:

| Address | Service |
| --- | --- |
| `169.254.169.254` | AWS, GCP, Azure instance metadata |
| `169.254.170.2` | ECS task metadata |
| `192.0.0.192` | Oracle Cloud |
| `100.100.100.200` | Alibaba |
| `168.63.129.16` | Azure WireServer |
| `fd00:ec2::254` | AWS metadata over IPv6 |

Then internal services with no authentication: Redis on 6379, Elasticsearch on 9200, an admin
panel on an RFC1918 address.

## Why the address is checked at connect time

Validating the URL when a destination is saved does not work. An attacker registers a hostname
they control that resolves to a public address, passes the check, then repoints DNS at
`127.0.0.1` before the first delivery. This is DNS rebinding, and the gap between checking a
name and using it is the whole attack.

`createDeliveryAgent` therefore validates the **resolved address at the moment of connection**,
inside undici's connector. There is no window between the check and the socket. Two hooks are
needed rather than one:

- `lookup`, passed at `buildConnector` time. A per-request `lookup` is silently ignored.
- a `connect` wrapper, because a literal address like `http://127.0.0.1/` never reaches DNS at
  all, and because `socket.remoteAddress` is the last chance to catch anything that resolved
  outside our shim.

This also handles redirects for free. Every hop opens a new socket through the same hook, so a
public URL that 302s to `169.254.169.254` is caught at the second connection rather than needing
its own rule. In practice we do not follow redirects anyway, and there is a test asserting the
destination is contacted exactly once.

## Happy Eyeballs

Node has `autoSelectFamily` on by default since Node 20, so `lookup` is called with `all: true`
and receives every resolved address. Node may connect to **any** of them. A guard that inspects
`addresses[0]` and passes the array through is exploitable by a hostname that resolves to one
public address and one private one. The filter runs over the whole array and fails closed when
nothing survives.

## What the blocklist has to cover beyond the obvious

Range membership alone is not enough, because IPv6 can carry an IPv4 address three different
ways and each looks like ordinary unicast to a classifier:

- IPv4-mapped, `::ffff:127.0.0.1`
- IPv4-compatible, `::127.0.0.1`
- 6to4, `2002:7f00:1::1`
- NAT64, `64:ff9b::7f00:1`

Each embedding is decoded and re-checked as IPv4.

Decimal, octal and hex forms (`http://2130706433/`, `http://0177.0.0.1/`, `http://127.1/`) are
normalised to a dotted quad by the WHATWG URL parser before anything else sees them. That is
load-bearing rather than incidental, so there is a test asserting the parser still does it. The
rule that follows is: never inspect a raw user string, always `new URL()` first and work from
`.hostname`.

One address is in no RFC range and is globally routable, so every classifier calls it public:
`168.63.129.16`, Azure's WireServer. It is hardcoded.

## The delivery log is an output channel

The person who chose the destination can read what came back, so the log is treated as
attacker-visible:

- **Response headers are allowlisted**, not blocklisted. `Content-Type`, `Content-Length` and
  `Retry-After` are kept. `Server` and `X-Powered-By` fingerprint internal software,
  `Set-Cookie` can carry internal session material, `WWW-Authenticate: Negotiate` is an NTLM
  relay lever, and `Location` on a 3xx describes internal topology.
- **The body is capped at 2 KB by aborting the stream**, not by reading it and slicing. Reading
  first would pull a multi-megabyte internal page into memory before the cap could apply.
- **Durations are quantised to 100 ms** and every non-blocked failure collapses to one opaque
  `delivery failed`. Otherwise connection-refused, connection-accepted-then-error and
  firewall-drop are separable by timing, which turns the relay into a port scanner for
  `127.0.0.1:1-65535`.
- **The URL may not carry credentials.** `new URL()` preserves `username` and `password`, so a
  destination of `https://admin:hunter2@example.com/` would write a password into that log.

## What is deliberately not done

**No port allowlist.** Blocking 22 and 25 sounds prudent and buys little once the address space
is closed, and it would break legitimate destinations on non-standard ports.

**No DNS pinning between the lookup and the connect.** Undici hands the resolved address
straight to `net.connect` in the same call, so there is no second resolution to race. If that
implementation detail changed, the post-connect `remoteAddress` check is what would still catch
it.

**No blocking of public addresses that happen to be internal to someone else.** A destination on
a public IP that belongs to a private network we cannot see is out of scope, and no address
filter can know that.

## Residual risk

`ALLOW_PRIVATE_DESTINATIONS` turns the guard off entirely. It exists because a single machine
cannot otherwise demo a delivery, since a local destination is on loopback. It defaults to off,
refuses any value other than `true` or `false` so a typo cannot silently disable it, and logs a
warning at boot when it is on. Anywhere destinations come from someone else, it must stay off.

There is no maintained npm package that does connect-time SSRF filtering correctly for undici.
`ip` has an unpatched CVE and still reports `127.1` as public, `ssrf-req-filter` does not work
with undici at all, and `request-filtering-agent` is an `http.Agent`. The filtering here is
therefore hand-written over `ipaddr.js`, which means it is ours to keep correct. The tests name
each bypass class so a regression is visible.
