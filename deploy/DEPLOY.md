# Deploying chrome.inkwork.studio

The app is a single Node process with a Chromium child. It needs:

- 2 vCPU / 2 GB RAM recommended (one browser, up to 4 contexts)
- 1 GB `/dev/shm` (Chromium)
- a persistent `./data` for the token and downloads
- loopback-only port exposure; TLS terminates at Cloudflare

## 1. Local / LAN

```bash
cd /workspace/chrome
npm install
node server.mjs
# http://127.0.0.1:8787/?token=$(cat data/token)
```

Open the console from a browser on the same LAN with `?token=…`, or put it
behind your own reverse proxy. Do not bind it to a public interface without the
token gate.

## 2. Docker (NAS)

The repo currently lives in the T3 workspace: host
`/mnt/Pool-1/apps/t3code/workspace/chrome`, container `/workspace/chrome`.
For a standalone deployment, copy it to `/mnt/Pool-1/apps/chrome` first so a T3
workspace change or restore cannot take the service with it:

```bash
sudo -n cp -a /mnt/Pool-1/apps/t3code/workspace/chrome /mnt/Pool-1/apps/chrome
```

The NAS is currently at ~1 GB free RAM while other agent work runs. Do not add
a 2 GB browser container until that frees up; the Mac is a better host for the
lowest latency anyway.

```bash
cd /mnt/Pool-1/apps/chrome/deploy
cp secrets.env.example secrets.env
chmod 600 secrets.env
# put a 48-byte random token in IW_TOKEN
openssl rand -base64 48
docker compose up -d --build
curl -s -H "Authorization: Bearer $(grep ^IW_TOKEN= secrets.env | cut -d= -f2)" \
  http://127.0.0.1:8787/health
```

The health check is unauthenticated on purpose and exposes no URLs or tokens.

Logs: `docker compose logs -f chrome`.
Stop: `docker compose down` (sessions are in memory and disappear).
Update: `docker compose up -d --build`.

Resource notes:
- `shm_size: 1gb` is required for Chromium; without it pages crash under load.
- `mem_limit: 2g` is a guardrail, not a guarantee. One context is ~60–120 MB;
  heavy sites (Google Docs, video) can double that.
- `cpus: 2.0` keeps one noisy agent from starving T3 Code.

## 3. Cloudflare tunnel + DNS

The existing NAS tunnel is **remotely managed** (ingress lives in Cloudflare,
not in a local YAML). Add the hostname; do not replace the whole ingress list,
or every other `*.inkwork.studio` service falls off.

### Dashboard route (least risk)

1. Cloudflare Zero Trust → Networks → Tunnels → the NAS tunnel → Public Hostname.
2. Add `chrome.inkwork.studio`, service `HTTP`, URL `127.0.0.1:8787`
   (or `chrome-inkwork:8787` if the connector is on the same Docker network).
3. DNS is created automatically as a proxied CNAME to
   `<tunnel-id>.cfargotunnel.com`.
4. Test: `curl -sI https://chrome.inkwork.studio/health` → 200.

### API route (what the dashboard does)

```bash
# Read the current ingress first, then PUT it back with the new rule appended.
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations"

# Append, preserving every existing rule:
#   {"hostname":"chrome.inkwork.studio","service":"http://127.0.0.1:8787"}
# then PUT the full {"config":{"ingress":[...]}} document.
```

DNS is a proxied CNAME `chrome` → `<tunnel-id>.cfargotunnel.com`.

### Access control

The app requires `Authorization: Bearer $IW_TOKEN` on every API/MCP route. The
console itself is public HTML but cannot call the API without the token, which
it stores in `localStorage` after a `?token=` bootstrap.

For a stronger gate, add Cloudflare Access (email OTP or Google) in front of the
hostname. That protects the console *and* the API; MCP clients then need a
service token or an Access bypass for `/mcp`.

Do not expose a bare `http://0.0.0.0:8787` to the internet. The token is the
whole security boundary; browsers controlled by this service can reach private
network addresses.

## 4. MCP wiring (T3 Code / OpenCode)

Remote MCP (streamable HTTP, stateless):

```json
{
  "mcpServers": {
    "chrome": {
      "type": "http",
      "url": "https://chrome.inkwork.studio/mcp",
      "headers": { "Authorization": "Bearer <IW_TOKEN>" }
    }
  }
}
```

Install the skill at `skill/SKILL.md` into
`~/.config/opencode/skills/chrome/SKILL.md` so the agent knows the discipline
(one intent per call, snap not screenshot, reflex for timers).

## 5. Verification after deploy

```bash
BASE=https://chrome.inkwork.studio
T=<IW_TOKEN>
curl -s $BASE/health
curl -s $BASE/api/sessions -H "Authorization: Bearer $T"
S=$(curl -s -X POST $BASE/api/sessions -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["id"])')
curl -s -X POST $BASE/api/s/$S/snap -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"max":40}' | head -c 600
curl -s -X POST $BASE/api/s/$S/close -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{}'
```

Also open the console, confirm the live view, then take control and type in a
search box. That exercises screencast + input over the public path.

## 6. Rollback

`docker compose down` removes the process; the tunnel hostname can be disabled
in the dashboard. No data migrations, no volumes to preserve except
`deploy/data/token`.
