# Run HookRelay and Devonoma locally

## One-command setup

From HookRelay, run:

```powershell
.\scripts\start-local-devonoma-flow.ps1
```

It generates an API key and endpoint signing secret, stores them only in ignored
local files, starts both apps, opens a temporary Cloudflare tunnel, and creates
or updates Devonoma's GitHub push webhook through your existing `gh` login.
It uses port 3200 for HookRelay and port 3100 for Devonoma, so it does not
collide with a project already using port 3000.

The command needs Docker Desktop, Node, Cloudflared, and an authenticated GitHub
CLI. It changes your local `.env` and `.env.local` files and the GitHub webhook
for Devonoma, but it never writes a secret into Git.

### What the automatic script does

1. Creates ignored local configuration and generates a new API key and signing
   secret when none exists.
2. Starts the HookRelay and Devonoma Docker databases, then applies migrations.
3. Starts HookRelay at `http://127.0.0.1:3200` and Devonoma at
   `http://127.0.0.1:3100`.
4. Creates the signed HookRelay endpoint for Devonoma.
5. Starts a temporary Cloudflare tunnel to HookRelay.
6. Creates or updates the Devonoma GitHub push webhook with that temporary URL.

The dashboard still asks for Basic Auth. Sign in with username `hookrelay` and
the `API_KEY` from HookRelay's ignored `.env` file. The browser usually keeps
that login for the rest of the session.

For a clean interview timeline, run it with `-ResetTimeline`. This deletes only
the local Devonoma activity rows, then starts the same flow:

```powershell
.\scripts\start-local-devonoma-flow.ps1 -ResetTimeline
```

The rest of this page is the manual version if you need to inspect each step.

This starts both apps on one machine and sends a GitHub push through HookRelay
to Devonoma. Keep the API key and endpoint signing secret in local files only.
They do not belong in Git, a README screenshot, or a public GitHub webhook URL.

## 1. Start HookRelay

Open PowerShell in the HookRelay repository.

```powershell
Set-Location D:\Programming\Projects\HookRelay

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
}

notepad .env
```

In `.env`, set a new long `API_KEY` and set
`ALLOW_PRIVATE_DESTINATIONS=true` and `PORT=3200`. Leave the database and Redis
defaults in place. The private-destination setting is for this local-only flow,
because Devonoma runs on `127.0.0.1`.

Then run:

```powershell
npm install
docker compose up -d --wait
npm run migrate:up
npm run dev
```

Keep this terminal open. HookRelay listens on `http://127.0.0.1:3200`.

## 2. Start Devonoma

Open a second PowerShell window.

```powershell
Set-Location D:\Programming\Projects\Devonoma

if (-not (Test-Path .env.local)) {
  Copy-Item .env.example .env.local
}

notepad .env.local
```

Set `DATABASE_URL` to the local default already shown in `.env.example`. Leave
`WEBHOOK_SECRET` empty for now; the next step creates one.

```powershell
npm install
docker compose up -d --wait
npm run migrate
npm run dev -- --hostname 127.0.0.1 --port 3100
```

Keep this terminal open. Devonoma listens on `http://127.0.0.1:3100`.

## 3. Create the connection

Open a third PowerShell window. Enter the API key you saved in HookRelay's
`.env` when prompted. This command creates an endpoint and prints its signing
secret once.

```powershell
Set-Location D:\Programming\Projects\HookRelay

$apiKey = Read-Host 'HookRelay API_KEY'
$headers = @{ Authorization = "Bearer $apiKey"; 'Content-Type' = 'application/json' }
$body = @{ name = 'devonoma-local'; destinationUrl = 'http://127.0.0.1:3100/api/webhooks/hookrelay' } | ConvertTo-Json
$endpoint = Invoke-RestMethod 'http://127.0.0.1:3200/endpoints' -Method Post -Headers $headers -Body $body

Write-Host "Ingest path: $($endpoint.ingestPath)"
Write-Host "Signing secret: $($endpoint.signingSecret)"
```

Copy the printed signing secret into Devonoma's `.env.local` as
`WEBHOOK_SECRET=<printed value>`, then restart the Devonoma terminal. Save the
ingest path; it is a capability URL and should be treated like a secret.

## Local interview demo

For an interview, stop here. You do not need Cloudflare, a public URL, or a
GitHub webhook. In the third PowerShell window, run this with the endpoint
values from step 3:

```powershell
Set-Location D:\Programming\Projects\Devonoma
$env:HOOKRELAY_INGEST_URL='http://127.0.0.1:3200/hook/<endpoint-id>'
$env:WEBHOOK_SECRET='<endpoint-signing-secret>'
npm run demo:push
```

The command sends a GitHub-shaped signed push locally. Show the delivered event
in HookRelay, then refresh Devonoma to show the same commit on its timeline.
Nothing leaves your laptop.

## Test a real GitHub push

With the automatic script running, make a commit and push it to Devonoma. The
push is what triggers GitHub's webhook. A local commit on its own does not.

### Commit in VS Code

1. Open the Devonoma folder in VS Code.
2. Open **Source Control** in the left sidebar.
3. Make a small change, stage it with the `+` button, and enter a commit message.
4. Select **Commit**.
5. Select **Sync Changes** or **Push**.

For a quick test without changing code, use the terminal command below instead.
It creates an empty commit, which VS Code's normal Commit button cannot create.

```powershell
Set-Location D:\Programming\Projects\Devonoma
git commit --allow-empty -m "verify local webhook flow"
git push
```

### Commit on GitHub's website

On the Devonoma repository page, open a text file such as `README.md`, select
the pencil icon, make a small edit, and select **Commit changes**. A web commit
is already on GitHub, so it triggers the webhook without a separate push. Revert
the small edit afterward if it was only for a demo.

## 4. Let GitHub reach HookRelay

In the third PowerShell window, start a temporary tunnel:

```powershell
cloudflared tunnel --url http://127.0.0.1:3200 --no-autoupdate
```

Cloudflared prints a temporary `https://...trycloudflare.com` URL. In your
GitHub repository's webhook settings, create a webhook with:

| Field | Value |
| --- | --- |
| Payload URL | `https://<temporary-tunnel-host><ingest-path>` |
| Content type | `application/json` |
| Secret | The endpoint signing secret from step 3 |
| Events | Push events |

Do not put the full payload URL or the signing secret in a public document.

## 5. Verify the full path

Make a small commit and push it:

```powershell
Set-Location D:\Programming\Projects\Devonoma
git commit --allow-empty -m "verify local webhook flow"
git push
```

Confirm the result in both places:

- HookRelay: `http://127.0.0.1:3200/dashboard`
- Devonoma: `http://127.0.0.1:3100`

GitHub can redeliver a webhook, but HookRelay intentionally de-duplicates the
same GitHub delivery ID. Use the HookRelay replay control to retry a stored
failed delivery instead.

## Stop local services

When you started the automatic flow, use its matching stopper:

```powershell
Set-Location D:\Programming\Projects\HookRelay
.\scripts\stop-local-devonoma-flow.ps1
```

It stops the remembered HookRelay, Devonoma, and Cloudflare processes, followed
by only these two projects' Docker containers. For the manual flow, stop the
two `npm run dev` terminals and the Cloudflare tunnel with `Ctrl+C`, then run:

```powershell
Set-Location D:\Programming\Projects\HookRelay
docker compose stop

Set-Location D:\Programming\Projects\Devonoma
docker compose stop
```

`stop` shuts down the containers without deleting your local database data. Use
`docker compose down` only when you also want to remove the containers; do not
add `-v` unless you deliberately want to erase the local databases.
