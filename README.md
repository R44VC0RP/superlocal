# Superlocal

## Run locally

1. Install dependencies with **Bun 1.4+**: `bun install`.
2. Run `bun run dev` and open **http://localhost:5178**.

The launcher runs Vite and the actual Inbox SDK host on loopback (backend port 8790). First run creates a private, git-ignored `superlocal.local.json` and a durable fictional inbox. No provider secrets, Google setup, OpenCan, or macOS tools are needed. **Ctrl-C stops both servers.** Mock mail never contacts a provider.

## Local configuration

Edit `superlocal.local.json` while the host is stopped. Its `instanceId` identifies this installation; keep it with its data. Runtime databases, encryption keys, and session keys live **outside the checkout**, under:

- macOS: `~/Library/Application Support/superlocal/<instanceId>/`
- Linux: `$XDG_DATA_HOME/superlocal/<instanceId>/` (default `~/.local/share`)
- Windows: `%LOCALAPPDATA%\superlocal\<instanceId>\`

Set `dataDir` to another private directory outside the checkout if needed. Mock and real data have separate subdirectories. Back up the whole instance directory together; missing/mismatched keys fail closed, never silently regenerate against an existing database. Existing pilot `.env.local` and SQLite files are not read, copied or migrated.

`web.port`, `backend.port`, `web.origin`, and `web.allowedOrigins` configure the local servers. A null `web.origin` means `http://localhost:<web.port>`. Exact loopback origins and the optional `super.local` alias are supported; this is **not a production or remote-access host**. If OpenCan is already configured, `https://super.local` remains an allowed alias; Superlocal does not install or manage it.

For an isolated run, set `SUPERLOCAL_CONFIG` to a new configuration filename and `SUPERLOCAL_DATA_DIR` to a new private directory. `SUPERLOCAL_WEB_PORT`, `SUPERLOCAL_API_PORT`, and `SUPERLOCAL_WEB_ORIGIN` override addresses without modifying the saved defaults. The configuration file's parent directory must exist. `bun run dev:host` starts only the backend.

## Enable real providers

1. Set `mode` to `real`, and set `providers.gmail.enabled` and/or `providers.inbound.enabled` to `true`. Only enabled providers in the selected mode are offered; mock is never mixed with real mail.
2. For Gmail, configure an OAuth web client and register `<web.origin>/v1/oauth/google/callback`. The default explicit references are `SUPERLOCAL_GOOGLE_CLIENT_ID` and `SUPERLOCAL_GOOGLE_CLIENT_SECRET`; export those yourself, or set the corresponding `providers.gmail.oauth` values to strings or `{ "env": "YOUR_VARIABLE_NAME" }`. No SDK `.env` file or unrelated ambient credentials are imported. Start OAuth from the configured `web.origin`, including when using the optional HTTPS alias.
3. Restart `bun run dev` and connect through the app. Inbound asks only for an API key, then offers SDK-discovered mailboxes. Keys go only to the host and are encrypted by the SDK; they are never returned to the browser. Gmail returns through the existing one-time, browser-bound OAuth flow.

Real connections default to normal mail access: `allowProviderWrites.real: true`, with Gmail requesting `gmail.modify` and `gmail.send` for reading, sending, and native changes. Older read-only grants need fresh consent before those actions are available. For an optional read-only setup, set the real write policy to `false` and use `https://www.googleapis.com/auth/gmail.readonly` with `openid` and `email` in the Gmail OAuth scope list. Provider scopes/capabilities are independent of this host policy. Mock writes also default to enabled. Local authentication is an expiring owner cookie established by a same-origin loopback session, not a native-app login or team ACL.
