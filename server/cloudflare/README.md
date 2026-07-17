# WebDAV for Obsidian behind a Cloudflare Tunnel

Expose the WebDAV server through a **Cloudflare Tunnel** instead of opening ports. Best when:

- ports 80/443 are already taken by another site / reverse proxy on the VPS,
- you don't want to open any inbound ports, or
- you want automatic HTTPS handled by Cloudflare (works great on iOS).

```
Obsidian (Linux / Android / iOS)
        │  HTTPS
        ▼
  Cloudflare edge  ──►  cloudflared (outbound tunnel)  ──►  obsidian-webdav (internal only)
```

The existing web server on the VPS is never touched. `cloudflared` dials out to Cloudflare,
so no firewall changes are needed.

## Requirements

- The domain (zone) must be on **Cloudflare** (Cloudflare nameservers).
- Docker + Docker Compose on the VPS.

## 1. Create the tunnel in Cloudflare (once)

1. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.** Name it e.g.
   `obsidian-dav`, save. Copy the **token** — the `eyJ...` string after `--token` in the
   install command.
2. Open the tunnel → **Add a route → Published application**:
   - **Subdomain:** `dav` (or your choice) · **Domain:** your zone → full hostname e.g.
     `dav.your-zone`
   - **Path:** leave empty
   - **Service URL:** `http://obsidian-webdav:80`  ← must be `http` and this exact name
   - **Add route.** Cloudflare creates the DNS record automatically.

> New dashboard note: pick **Published application** (public hostname), *not* **Private
> hostname** (that one is WARP-only and won't give a public URL).

## 2. Start the stack

```bash
chmod +x setup.sh
./setup.sh
```

`setup.sh` asks for a WebDAV username/password and the tunnel token, writes `.env`, and starts
`obsidian-webdav` + `obsidian-cloudflared`. Or do it manually:

```bash
cp .env.example .env
# edit .env: WEBDAV_USER, WEBDAV_PASSWORD, TUNNEL_TOKEN
docker compose up -d
```

## 3. Verify

```bash
HOST=dav.your-zone
U=obsidian:your-password
curl -o /dev/null -w "%{http_code}\n" -X PROPFIND -H "Depth: 0" -u "$U" https://$HOST/   # 207
```

`401` without auth and `207` with auth means it works end to end.

## 4. Plugin settings

| Field | Value |
|-------|-------|
| Host | your public hostname, e.g. `dav.your-zone` |
| Port | `443` |
| HTTPS | on |
| User | `WEBDAV_USER` |
| Password | `WEBDAV_PASSWORD` |

## Operations

```bash
docker compose logs -f cloudflared     # tunnel connection status
docker compose restart                 # apply .env changes
docker compose down                    # stop (data stays in ./data)
tar czf obsidian-backup-$(date +%F).tar.gz data/
```

## Good to know

- **Cloudflare Free caps a request body at 100 MB.** Notes are tiny, so this only matters for
  very large attachments (e.g. long videos), which won't upload through the tunnel.
- Cloudflare does **not** cache authenticated WebDAV responses (`cf-cache-status: BYPASS`), so
  devices never see stale files. If you ever remove auth, add a Cache Rule to bypass cache for
  the hostname.
- Do **not** put Cloudflare Access in front of this hostname — the plugin can't pass an Access
  login. WebDAV's own Basic auth is the access control here.
- Keep `.env` (tunnel token + WebDAV password) private; it's git-ignored.
