#!/usr/bin/env bash
# One-shot setup for the Obsidian WebDAV server on your VPS.
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
#
# It creates a .env (asking for user / password / domain), then starts the containers.
# Re-running is safe: it re-reads .env and restarts the stack.

set -euo pipefail
cd "$(dirname "$0")"

echo "== Obsidian WebDAV server setup =="

# --- prerequisites -------------------------------------------------------------------
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

# --- .env ----------------------------------------------------------------------------
if [ -f .env ]; then
	echo "Using existing .env"
else
	echo "Let's create your .env"
	read -rp "WebDAV username [obsidian]: " user
	user="${user:-obsidian}"

	default_pass="$(openssl rand -base64 24 2>/dev/null | tr -d '/+=' | cut -c1-24 || echo "change-me-$(date +%s)")"
	read -rp "WebDAV password [${default_pass}]: " pass
	pass="${pass:-$default_pass}"

	read -rp "Domain for HTTPS (blank = http/IP only, no iOS): " domain
	domain="${domain:-}"

	{
		echo "WEBDAV_USER=${user}"
		echo "WEBDAV_PASSWORD=${pass}"
		echo "DOMAIN=${domain}"
	} > .env
	echo "Wrote .env"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

mkdir -p data

# --- warn about http-only mode -------------------------------------------------------
if [ -z "${DOMAIN:-}" ]; then
	echo
	echo "!! No DOMAIN set — starting WebDAV without HTTPS."
	echo "   Make sure the 'ports: 8080:80' lines are uncommented in docker-compose.yml,"
	echo "   and note that iOS will refuse a plain-http server."
fi

# --- go ------------------------------------------------------------------------------
echo
echo "Starting containers…"
$COMPOSE up -d

echo
echo "== Done =="
echo "Enter these in the Obsidian plugin (WebDAV Sync settings):"
if [ -n "${DOMAIN:-}" ]; then
	echo "  Host (адрес):  ${DOMAIN}"
	echo "  Port (порт):   443"
	echo "  HTTPS:         on"
else
	ip="$(curl -s https://api.ipify.org 2>/dev/null || echo "<your-vps-ip>")"
	echo "  Host (адрес):  ${ip}"
	echo "  Port (порт):   8080"
	echo "  HTTPS:         off"
fi
echo "  User (юзер):   ${WEBDAV_USER}"
echo "  Password:      ${WEBDAV_PASSWORD}"
echo
echo "Then press 'Подключиться и настроить' in the plugin. That's it."
