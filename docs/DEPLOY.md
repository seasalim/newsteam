# Deployment

NewsTeam is a single Node.js process. The Python tools use only the standard
library, so there is no pip installation step.

NewsTeam is published at `github.com/seasalim/newsteam`. Create a clean
checkout with:

```bash
git clone https://github.com/seasalim/newsteam.git
cd newsteam
```

The persona runtime directory is provided through `NEWSTEAM_PERSONA_DIR`.

## Docker (recommended)

Install Docker Desktop or Docker Engine, then from the repository root:

```bash
cp .env.example .env
cp config.example.yaml config.yaml
mkdir -p persona logs
cp -r examples/personas/kingclawd persona/kingclawd

# Add the configured model API key to .env. The template defaults to local chat.
# For Discord, change channel.provider and fill in its channel/user IDs.
docker compose up -d --build
docker compose logs -f newsteam
docker compose ps
```

Confirm the configured example persona is available. The dashboard responds at
[http://127.0.0.1:7777](http://127.0.0.1:7777), and local chat responds at
[http://127.0.0.1:7777/chat](http://127.0.0.1:7777/chat) when selected.
The Compose file binds it to localhost only. Stop the service with
`docker compose down`; update it with `docker compose up -d --build`. To build
the image directly, run `docker build -t newsteam .`.

### Local-channel security

The default `127.0.0.1` binding is the local channel's security boundary and
requires no token. If `LOCAL_CHANNEL_TOKEN` is set, all chat and dashboard
requests require `Authorization: Bearer <token>` or an initial visit to
`/chat?token=<token>`, which stores an HTTP-only cookie and redirects to the
clean URL. A non-loopback `DASHBOARD_HOST` without a token emits a prominent
startup warning. Use a TLS reverse proxy plus `LOCAL_CHANNEL_TOKEN` whenever
exposing the service beyond the host machine; permissive CORS is not enabled.

**Windows** is supported via Docker Desktop or WSL2 (run the Linux
instructions inside WSL). WSL usually cannot auto-open the demo browser, so
use the printed local-chat URL. Native Windows is not supported because tool
execution spawns `python3` subprocesses. Native Windows support belongs on the
roadmap only if users ask.

## Linux (systemd)

Install Node.js 22+, Python 3.11+, and the repository under `/opt/newsteam`.
Create `/opt/newsteam/.env`, copy `config.example.yaml` to
`/opt/newsteam/config.yaml`, and copy an example persona into
`/opt/newsteam/persona/`. Build before enabling the service:

```bash
cd /opt/newsteam
npm ci
npm run build
```

Save this unit as `/etc/systemd/system/newsteam.service`:

```ini
[Unit]
Description=NewsTeam self-hosted news team
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/newsteam
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/opt/newsteam/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now newsteam.service
sudo journalctl -u newsteam.service -f
```

## macOS (launchd)

Build and install the user agent from the repository root:

```bash
npm ci
npm run build
./service/install.sh
```

The installer writes a templated `com.newsteam.plist` to
`~/Library/LaunchAgents/`, starts it for the logged-in user, and stores logs in
`logs/`. For source changes, run `npm run deploy` or:

```bash
npm run build
launchctl kickstart -k "gui/$(id -u)/com.newsteam"
```

Useful lifecycle commands:

```bash
launchctl bootout "gui/$(id -u)/com.newsteam"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.newsteam.plist"
./service/install.sh --uninstall
```
