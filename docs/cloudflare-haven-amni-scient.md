# Cloudflare for haven.amni-scient.com

This uses the same named tunnel as `chat.amni-scient.com` (`amni-inc`, already running as the Windows **Cloudflared** service). Do not turn on Haven’s built-in quick tunnel. That one mints a random `trycloudflare.com` URL and fights this hostname.

## Dashboard (do this once)

1. Open [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels**.
2. Open the tunnel named **amni-inc** (same one chat uses).
3. **Public Hostname** → **Add a public hostname**.

| Field | Value |
| --- | --- |
| Subdomain | `haven` |
| Domain | `amni-scient.com` |
| Type | HTTP |
| URL | `localhost:3010` |

4. Under additional settings (names move around; look for **Origin** / **HTTP**):
   - **HTTP Host Header**: `haven.amni-scient.com`
   - Leave TLS verification off; the origin is plain HTTP on the box.
   - Do not wrap this hostname in **Cloudflare Access**. Amni-Haven on Android would hit the Access login instead of Haven.
5. Save. Cloudflare creates a proxied CNAME `haven` → `<tunnel-id>.cfargotunnel.com`. You should not also add a manual A record for `haven`.

## Zone settings (amni-scient.com)

These are the ones that break Haven if they are wrong:

- **SSL/TLS** → **Full**. The browser talks HTTPS to Cloudflare; Cloudflare talks HTTP to `cloudflared` on this PC.
- **Network** → **WebSockets** on (default). Socket.IO needs it.
- **Caching** → a Cache Rule for hostname `haven.amni-scient.com`: **Bypass**. Socket.IO and the app shell should not be cached.
- **Bot Fight Mode / Super Bot Fight** off for this hostname, or skip `/socket.io/*`. Aggressive bot scores drop live chat.
- **WAF**: if you add rules later, allow `/socket.io/` and `Upgrade: websocket`.

## Voice and video

The tunnel carries the Haven page and Socket.IO. WebRTC media is peer-to-peer (or TURN). Cloudflare STUN is already in Haven. If callers on different NATs get one-way audio, add a TURN server in Haven **Settings → Admin → Voice & Connectivity**. A tunnel hostname does not replace TURN.

## After the hostname exists

1. Double-click `Start Haven Public.bat` in the Haven repo (listens on `127.0.0.1:3010` only).
2. Open `https://haven.amni-scient.com`.
3. Register as `amnibro` (that name is admin). Then run `node scripts/seedAmniScientCommunity.js` again so the Tester role menu is posted.
4. In Amni-Haven, add server URL `https://haven.amni-scient.com`.
