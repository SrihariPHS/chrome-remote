# Deploying

The service is one Node process plus a Chromium child. That is the whole moving part.

## Sizing

| | minimum | comfortable |
| --- | --- | --- |
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB for 4 sessions |
| `/dev/shm` | 512 MB | 1 GB |
| disk | 500 MB | 2 GB with downloads |

Each session is a Chromium context (~80–150 MB). `IW_MAX_SESSIONS` is the real
memory dial: 4 sessions on 2 GB, 2 on 1 GB.

## Docker

```bash
docker compose up -d --build          # root docker-compose.yml
docker compose logs chrome | head -20 # prints the URL with its token
```

The token is generated on first boot and persisted in the `chrome-data` volume.
Rotate it by deleting `/data/token` and restarting.

## Behind TLS

Never publish port 8787 directly. Put a proxy in front and keep the container on
loopback or a private network.

Caddy:

```
chrome.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Cloudflare Tunnel (`cloudflared`):

```yaml
tunnel: <id>
ingress:
  - hostname: chrome.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

WebSockets are required for the live view (`/api/s/{id}/live`); both proxies above
pass them through by default.

### Sign-in for people

Set `IW_PIN` to six digits. A phone can then sign in with the PIN instead of pasting
a 32-character token; the PIN sets an HttpOnly cookie for 30 days. Agents keep using
the bearer token.

## Operating it

- `GET /health` is unauthenticated: `browser`, `launch_ms`, `sessions`, and p50/p95
  per operation. It is the first thing to read when something feels slow.
- `IW_SESSION_TTL_MIN=20` reaps idle sessions so a forgotten tab cannot hold a
  browser forever.
- `IW_DEBUG=1` logs request errors to stdout.
- The human window is `/`; diagnostics are `/console`. Both need auth.

## Notes

- `IW_HEADFUL=1` runs Chromium under Xvfb (the Docker image does this). It is slower
  to start but behaves more like a real browser on sites that check for headless.
- The screencast is JPEG over one WebSocket, so it costs bandwidth: roughly
  10–40 KB per changed frame at 55% quality, capped at 4 fps per viewer when the
  page is not repainting.
- Sessions persist cookies to `data/profiles/<name>.json` on close, so a login
  survives a session being recreated. It is a single named profile, not per user.
