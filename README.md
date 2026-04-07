# Discord Role Cleanup Bot

Small `discord.js` bot for:

- assigning the `unverified` role to new members
- removing `unverified` when Linked Roles adds `verified`
- letting members use `/live` to add the "Live Now" role manually
- letting members use `/unlive` to remove the "Live Now" role manually
- linking Discord users to Twitch accounts with moderator approval
- automatically syncing the same "Live Now" role from approved Twitch live status
- automatically removing the manual live role after a configurable delay when Twitch is not reporting the user as live
- running a startup scan once per process to clean up members who already have both verification roles

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in the bot token, Discord role IDs, Twitch credentials, and Postgres connection string.
4. Run `npm install`.
5. Run `npm start`.

After the bot starts in your guild, Discord should register `/live`, `/unlive`, `/linktwitch`, `/unlinktwitch`, `/mytwitch`, `/approvetwitch`, and `/denytwitch`.

For local development, you can also use:

```powershell
npm run dev
```

## Required environment variables

- `DISCORD_BOT_TOKEN`
- `VERIFIED_ROLE_ID`
- `UNVERIFIED_ROLE_ID`
- `LIVE_NOW_ROLE_ID`
- `LOG_CHANNEL_ID`

## Twitch and database environment variables

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TWITCH_POLL_INTERVAL_MS`
- `DATABASE_URL`
- `DATABASE_SSL`

## How Twitch linking works

- `/linktwitch username:<string>` validates the Twitch username through the Twitch API and stores it in Postgres.
- `/mytwitch` shows the caller's current Twitch link and approval state.
- `/unlinktwitch` removes the caller's mapping.
- `/approvetwitch user:<discord user>` marks that mapping approved.
- `/denytwitch user:<discord user>` clears approval.
- Only approved mappings are included in automatic Twitch live polling.

The bot creates a `twitch_links` table automatically if it does not already exist.

## Render setup

This repo includes `render.yaml`. On Render:

1. Create a new Worker Service from this repo.
2. Confirm the build command is `npm install`.
3. Confirm the start command is `npm start`.
4. Set `DISCORD_BOT_TOKEN`, your Discord IDs, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `DATABASE_URL`.
5. Set DATABASE_SSL=false on Render when using the internal database URL.
6. For local development against the external database URL, set DATABASE_SSL=true.

## Notes

The Twitch poller batches `Get Streams` requests in groups of up to 100 login names and waits for 2 consecutive offline results before removing the live role.

Manual `/live` and `/unlive` still work as a fallback lane. Manual timeout removal will not strip the role while Twitch still reports that user as live.

This bot does not expose an HTTP server, so a Render worker is the right fit.



