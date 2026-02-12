# claude-quota-cli

CLI tool for monitoring Claude AI subscription quotas. Real-time usage data from claude.ai.

```
☁️  Claude Quota Status

┌────────┬────────────────────────────┬──────────┬──────────┐
│ Window │ Usage                      │ Reset In │ Reset At │
├────────┼────────────────────────────┼──────────┼──────────┤
│ 5-hour │ ████░░░░░░░░░░░░░░░░ 22.0% │ 1h 56m   │ 19:59    │
├────────┼────────────────────────────┼──────────┼──────────┤
│ 7-day  │ ░░░░░░░░░░░░░░░░░░░░ 2.0%  │ 164h 56m │ 14:59    │
└────────┴────────────────────────────┴──────────┴──────────┘
```

## Setup

```bash
npm install
npx playwright install chromium
npm run build
```

## Configuration

Get credentials from claude.ai:

1. **sessionKey**: DevTools → Application → Cookies → `sessionKey`
2. **Organization ID**: https://claude.ai/settings/account → Organization ID

```bash
claude-quota config --session-key "sk-ant-sid..." --org-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Optionally add Discord webhook:

```bash
claude-quota config --session-key "..." --org-id "..." --webhook "https://discord.com/api/webhooks/..."
```

Config is stored in `~/.claude-quota/config.json`.

## Usage

```bash
# Show current quota
claude-quota status

# JSON output
claude-quota status --json

# Watch mode (refresh every 60s)
claude-quota watch
claude-quota watch --interval 30

# Discord alerts at 80/60/40/20% thresholds
claude-quota monitor
claude-quota monitor --interval 5 --webhook "https://discord.com/api/webhooks/..."

# One-shot monitor (for cron)
claude-quota monitor --once
```

## How it works

Uses Playwright to fetch real-time quota data from `claude.ai/api/organizations/{orgId}/usage`, bypassing Cloudflare protection. Returns actual utilization percentages and reset times for both 5-hour and 7-day windows.

## License

MIT
