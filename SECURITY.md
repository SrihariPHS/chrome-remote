# Security

This service drives a real browser. Access to it is access to every page that
browser can reach, and to anything a page could do from that network position.

## The default posture

- A token is generated on first boot and stored in `data/token` (0600).
- Every `/api/*` request, `/mcp` call and WebSocket upgrade requires the token,
  either as `Authorization: Bearer …` or (for WebSockets and links) `?token=…`.
- `IW_OPEN=1` disables authentication. It exists for a laptop on localhost. It is
  not a deployment option.
- Sessions are isolated browser contexts with no imported profile or cookies.
- Uploads are confined to `data/uploads`; URLs are limited to `http(s)` and
  `about:blank` unless `IW_ALLOW_FILE=1`.
- PIN logins are rate-limited per IP (5 attempts, then 5 minutes).
- `eval` runs JavaScript inside the page — not in Node — but page JavaScript can
  still reach internal network addresses. Treat the service as a network foothold
  and keep it off any network you do not want a browser to see.

## If you expose it

1. Terminate TLS in front of it (Cloudflare tunnel, Caddy, nginx) and do not publish
   the port directly.
2. Set `IW_PIN` so a phone can sign in without pasting a token, and keep the token
   for agents.
3. Set `IW_MAX_SESSIONS` and `IW_SESSION_TTL_MIN` so a forgotten tab cannot hold a
   browser forever.
4. Rotate the token by deleting `data/token` and restarting.

## Reporting

Email the owner of the deployment, or open a private security advisory on the
repository. Please do not open a public issue for a vulnerability.
