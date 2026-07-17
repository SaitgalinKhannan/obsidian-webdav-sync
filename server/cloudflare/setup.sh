#!/usr/bin/env bash
# Set up WebDAV for Obsidian behind a Cloudflare Tunnel.
#
# Prerequisites (done once in the Cloudflare dashboard, see README.md):
#   1. Zero Trust -> Networks -> Tunnels -> Create a tunnel (Cloudflared). Copy its token.
#   2. Add a route -> Published application:
#        Subdomain: dav (or your choice)   Domain: your-zone
#        Service URL: http://obsidian-webdav:80
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
#
# Re-running is safe: it re-reads .env and restarts the stack.

set -euo pipefail
cd "$(dirname "$0")"

echo "== Obsidian WebDAV over Cloudflare Tunnel =="

if ! command -v docker >/dev/null 2>&1; then
	echo "Docker is not installed. Install it first, e.g.:  curl -fsSL https://get.docker.com | sh"
	exit 1
fi

if docker compose version >/dev/null 2>&1; then
	COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
	COMPOSE="docker-compose"
else
	echo "Docker Compose is not available. Install the Docker Compose plugin and retry."
	exit 1
fi

if [ -f .env ]; then
	echo "Using existing .env"
else
	echo "Let's create your .env"
	read -rp "WebDAV username [obsidian]: " user
	user="${user:-obsidian}"

	default_pass="$(openssl rand -base64 24 2>/dev/null | tr -dc 'A-Za-z0-9' | cut -c1-24 || echo "change-me-$(date +%s)")"
	read -rp "WebDAV password [${default_pass}]: " pass
	pass="${pass:-$default_pass}"

	echo "Paste the Cloudflare Tunnel token (the eyJ... value after --token):"
	read -rp "TUNNEL_TOKEN: " token
	if [ -z "${token}" ]; then
		echo "A tunnel token is required. Create the tunnel in the Cloudflare dashboard first."
		exit 1
	fi

	{
		echo "WEBDAV_USER=${user}"
		echo "WEBDAV_PASSWORD=${pass}"
		echo "TUNNEL_TOKEN=${token}"
	} > .env
	chmod 600 .env
	echo "Wrote .env"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

mkdir -p data

echo
echo "Starting containers…"
$COMPOSE up -d

echo
echo "Waiting for the tunnel to register…"
sleep 6
docker logs obsidian-cloudflared 2>&1 | grep -iE "Registered tunnel connection|ERR" | tail -4 || true

echo
echo "== Done =="
echo "In the Cloudflare dashboard the route's Service URL must be:  http://obsidian-webdav:80"
echo
echo "Enter these in the Obsidian plugin (WebDAV Sync settings):"
echo "  Host:      <your public hostname, e.g. dav.your-zone>"
echo "  Port:      443"
echo "  HTTPS:     on"
echo "  User:      ${WEBDAV_USER}"
echo "  Password:  ${WEBDAV_PASSWORD}"
echo
echo "Then press 'Подключиться и настроить' in the plugin."
