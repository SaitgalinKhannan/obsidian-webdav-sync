# WebDAV server for Obsidian WebDAV Sync

Self-hosted WebDAV on your VPS: an Apache/mod_dav container behind Caddy (automatic HTTPS).
Your notes are stored as plain files under `./data`.

## Quick start

```bash
chmod +x setup.sh
./setup.sh
```

`setup.sh` asks for a username, password and domain, writes `.env`, and starts the stack.
It then prints exactly what to type into the Obsidian plugin.

## Manual start

```bash
cp .env.example .env
# edit .env: WEBDAV_USER, WEBDAV_PASSWORD, DOMAIN
docker compose up -d
```

## HTTPS vs http

| Mode | Setup | iOS | Android / Desktop |
|------|-------|-----|-------------------|
| **HTTPS (domain)** | A record → VPS, ports 80+443 open, set `DOMAIN` | ✅ | ✅ |
| **http (IP only)** | uncomment `ports: 8080:80`, leave `DOMAIN` blank | ❌ | ✅ |

iOS refuses plain-http endpoints, so use the domain + HTTPS path for full device coverage.

## Firewall

Open the ports you use:

```bash
# HTTPS mode
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
# http test mode
sudo ufw allow 8080/tcp
```

## Operations

```bash
docker compose logs -f caddy     # watch certificate issuance / requests
docker compose restart           # apply .env changes
docker compose down              # stop (data stays in ./data)
```

## Backups

Everything is plain files:

```bash
tar czf obsidian-backup-$(date +%F).tar.gz data/
```

## Security notes

- Use a long, unique `WEBDAV_PASSWORD`. It equals full access to your notes.
- Keep `.env` and `data/` off any public git remote (the repo `.gitignore` already excludes them).
- Consider fail2ban / a non-standard SSH port on the VPS as usual hardening.
