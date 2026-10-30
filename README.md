# THE TOUCHLINE REFERENDUM
## Messi vs. Ronaldo — Official Public Vote Counter

> **The definitive, unfiltered global football ballot.** No PR lobbies. No bot farms. No "Bluetooth Player Of All Time" awards. Just raw, verified public opinion.

---

## Quick Start (Node.js Server Mode)

```bash
# Node.js 18+ required. Zero npm dependencies.
cd goat-vote
node server.js

# Open in browser:
# http://localhost:3000
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on |
| `SECRET` | auto-generated | HMAC secret for token signing. Set to a persistent value in production (e.g. via Docker secrets or Render env vars) |
| `TRUST_PROXY` | `0` | Set to `1` ONLY when running behind nginx, Cloudflare, Railway, Render, or similar trusted reverse proxies. This enables reading `X-Forwarded-For` for real client IPs. **Never set to 1 on a server with direct internet access** |

## Security Architecture

### Multi-Layer Bot Prevention

| Layer | Mechanism |
|---|---|
| **PoW (SHA-256)** | Each vote requires solving a 4-leading-zero SHA-256 hash challenge. Takes ~150–300ms in a browser — trivial for humans, expensive for bots at scale |
| **HMAC Signed Tokens** | Challenge tokens are HMAC-SHA256 signed with a server secret, bound to the caller's IP, and expire in 10 minutes |
| **Single-Use Tokens** | Each challenge token can only be used once (replay protection via in-memory token set) |
| **4-Hour IP Cooldown** | IPs (stored as HMAC hashes, never raw) are locked for 4 hours after voting |
| **IPv6 /64 Grouping** | IPv6 addresses are grouped by /64 subnet, preventing subnet rotation attacks |
| **Min-Age Enforcement** | Tokens must be at least 3 seconds old before use — prevents automated challenge→vote pipelines |
| **Rate Limits** | Per-IP: 90 req/min global, 10 challenges/min, 6 votes/10min. Server-wide: 150 votes/min flood cap |
| **Strike System** | Suspicious activity accumulates strikes. 8 strikes = 1-hour IP ban |
| **Bot UA Blocking** | Common bot/scraper User-Agent strings are blocked |
| **Same-Origin Enforcement** | `Origin` header must match server `Host` — blocks cross-origin API abuse |
| **Honeypot Fields** | Two hidden form fields that humans never fill. Bots that fill them are insta-banned |
| **Timing-Safe Comparison** | Token HMAC comparison uses `crypto.timingSafeEqual` to prevent timing attacks |

### Data Privacy

- **Raw IPs are NEVER stored.** Only the HMAC-SHA256 of the normalized IP is stored in `data.json`.
- `data.json` contains vote counts and HMAC'd voter records. Listed in `.gitignore` — do NOT commit to public repositories.
- `.secret` contains the HMAC signing key. `.gitignore`'d — guard it like a password.

---

## Deployment Options

### Option A: Static HTML Only (GitHub Pages / Vercel / Netlify / Cloudflare Pages / S3)

Upload `goat_vote_counter_messi_vs_ronaldo.html` (rename to `index.html`) and serve statically.

**Limitations**: In this mode, votes are stored only in the browser's `localStorage` and `IndexedDB`. Votes are per-device and not globally shared. The 4-hour cooldown is enforced per-device.

**Best for**: Personal demos, one-device testing.

### Option B: Node.js Server (Railway, Render, Fly.io, VPS)

The recommended production mode. Votes are stored on the server in `data.json`, globally shared, and the full security stack is active.

**Railway (one-click)**:
```bash
# Install Railway CLI, then:
railway login
railway init
railway up
railway variables set SECRET=$(openssl rand -hex 32)
railway variables set TRUST_PROXY=1
```

**Render**:
1. Connect the GitHub repo
2. Set build command: (none — no dependencies)
3. Set start command: `node server.js`
4. Add env vars: `SECRET`, `TRUST_PROXY=1`, `PORT=10000`

**Docker**:
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**Nginx Reverse Proxy** (when using TRUST_PROXY=1):
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

---

## Why Bots Can't Easily Cheat

**Problem**: Different IPs bypassing cooldown.

**Answer**: Even with different IPs, each request must:
1. Solve a valid SHA-256 PoW (costs ~200ms CPU per vote, minimum)
2. Wait at least 3 seconds between challenge request and vote submission
3. Not use a recognized bot User-Agent
4. Send the correct `Origin` header
5. Not fill any honeypot field
6. Have a valid HMAC-signed, unexpired, single-use token bound to *that IP*

A bot farm using 1,000 rotating IPs would need: 1,000 unique IPs × (3-sec minimum wait + 200ms PoW) = ~54 minutes for 1,000 votes. With the 150 votes/minute global flood cap, that caps at ~9,000 votes/hour maximum — and each suspicious pattern triggers the strike/ban system. For a community-scale poll, this is sufficient deterrence against all but the most expensive, professionally-operated bot farms.

---

## File Structure

```
goat-vote/
├── server.js              ← Zero-dependency Node.js server
├── public/
│   └── index.html         ← Frontend (Tailwind CDN, self-contained)
├── data.json              ← Vote counts + HMAC'd voter records [.gitignore'd]
├── .secret                ← HMAC signing secret [.gitignore'd]
├── .gitignore             ← Excludes sensitive files from git
└── README.md              ← This file
```

---

## Contributing & Development

The codebase is intentionally dependency-free for auditability. No `npm install` required.

To inspect what's being stored:
```bash
node -e "const d = require('./data.json'); console.log('Messi:', d.counts.messi, '| Ronaldo:', d.counts.ronaldo, '| Active voters:', Object.keys(d.voters).length)"
```

To reset votes (for testing):
```bash
node -e "const fs=require('fs'); fs.writeFileSync('data.json', JSON.stringify({counts:{messi:0,ronaldo:0},voters:{}}, null, 2)); console.log('Reset.');"
```
