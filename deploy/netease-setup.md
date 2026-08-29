# NetEase Cloud Music playback source — sidecar setup

The Recordings tab can play your own songs from NetEase Cloud Music (网易云音乐).
The audio bytes stream **directly from NetEase's CDN** to the visitor's browser —
your server only resolves the CDN URL via a local sidecar and answers with a
302 redirect. **Zero audio traffic flows through your server.**

Architecture:

```
browser ── GET /api/netease/audio/<songId> ──▶ benpage (server.js)
                                                       │
                                          (sidecar, 127.0.0.1:3001)
                                GET /song/url/v1?id=… ◀─┘  (local only)
                                                       │
                                  302 Location: https://m801.music.126.net/…
browser ── GET https://…m801.music.126.net/… ◀─────────┘
                ▲ audio bytes stream here, NEVER through your server
```

## 1. Install the sidecar (one time, on the server)

Requires Node.js ≥ 16 (the same node that runs benpage works).

```bash
sudo npm install -g NeteaseCloudMusicApi
```

## 2. Run it as a service (systemd)

Copy the unit file and start it:

```bash
sudo cp deploy/netease-api.service /etc/systemd/system/netease-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now netease-api
sudo systemctl status netease-api
```

Smoke test from the server (should print JSON with a `url` field — or a null
url for tracks that require VIP login):

```bash
curl -s 'http://127.0.0.1:3001/song/url/v1?id=347230'
```

If the port is already taken, edit `PORT=` in the unit file (or the
`NETEASE_API_BASE` env var on the benpage side — see below) and restart.

## 3. Point benpage at the sidecar (optional, default is already correct)

`netease.js` reads `NETEASE_API_BASE`, defaulting to `http://127.0.0.1:3001`.
If you changed the sidecar port, set the env var when starting the app:

```bash
NETEASE_API_BASE=http://127.0.0.1:3001 PORT=3000 npm start
```

No nginx changes are needed: `/api/netease/…` is proxied to the app like
every other `/api/` path, and the 302 Location header points at NetEase's CDN
(an external https host), which is already allowed by the site CSP
(`media-src 'self' https: blob:`).

## 4. Add a song in the admin panel

1. Log in → **Music** tab → **+ Add Track**.
2. Click **🎵 从网易云导入**, search, and pick a song.
   The title is filled in automatically and the URL is set to
   `/api/netease/audio/<songId>`.
3. Save. The Recordings tab plays it with no other changes (the front end only
   ever reads `player.url`).

## Notes / troubleshooting

- **Anonymous playback is 128k standard quality.** To unlock higher quality,
  log the sidecar into a NetEase account (QR login):
  ```bash
  curl -s -X POST 'http://127.0.0.1:3001/login/qr/key'            # step 1: unikey
  curl -s -X POST 'http://127.0.0.1:3001/login/qr/create?key=…'  # step 2: scan QR
  curl -s -X POST 'http://127.0.0.1:3001/login/qr/check?key=…'   # step 3: poll
  ```
  The session cookies are stored by the sidecar; benpage doesn't need to know
  your account. If you don't want to risk a login, keep it anonymous — your own
  uploaded songs still play fine at standard quality.
- **"该歌曲暂不可播放" (404 from the audio endpoint):** the track needs VIP
  login or is region/copyright restricted. Try the QR login above.
- **"网易云 API 不可用（无法连接 http://127.0.0.1:3001/…：connect ECONNREFUSED …）"**
  (502 from search): benpage cannot open a TCP connection to the sidecar — the
  sidecar is not listening on `127.0.0.1:3001`. This is the #1 failure after a
  fresh deploy. Diagnose in order:
  1. Is the service running?
     ```bash
     sudo systemctl status netease-api --no-pager
     sudo journalctl -u netease-api -n 50 --no-pager     # 看启动失败的真实原因
     ```
  2. Is anything listening on 3001? `sudo ss -ltnp | grep 3001`
  3. Smoke test: `curl -s http://127.0.0.1:3001/` — if this doesn't return the
     sidecar index page, fix the service first, then restart benpage (its
     startup log prints `NetEase sidecar OK at …` when reachable).
- **`command not found` when starting the service:** node was installed with
  **nvm**, so the global bin (`~/.nvm/…/bin/NeteaseCloudMusicApi`) is not in
  systemd's PATH and `www-data` can't read `/home/<user>` anyway. Fix: use the
  absolute path in `ExecStart=` (see comments in `deploy/netease-api.service`),
  or install system node + reinstall globally:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  sudo npm install -g NeteaseCloudMusicApi
  sudo systemctl restart netease-api
  ```
- **benpage in Docker/container:** `127.0.0.1` inside a container is the
  container itself. Either run the sidecar in the same container/network
  namespace, or point benpage at the host loopback with
  `NETEASE_API_BASE=http://<host-ip>:3001`.
- **Sidecar's own rate limits:** NeteaseCloudMusicApi is single-process; the
  10-minute in-memory cache in `server.js` keeps repeated playbacks from
  hammering it. Seeks happen straight on the NetEase CDN (it answers 206 Range
  requests), so dragging the waveform doesn't touch the sidecar at all.
