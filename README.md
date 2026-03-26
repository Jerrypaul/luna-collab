# Discord Role Cleanup Bot

Small `discord.js` bot for:

- assigning the `unverified` role to new members
- removing `unverified` when Linked Roles adds `verified`
- letting members use `/live` to add the "Live Now" role
- letting members use `/unlive` to remove the "Live Now" role early
- automatically removing the "Live Now" role after a configurable delay
- running a startup scan once per process to clean up members who already have both verification roles

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in the bot token and IDs.
4. Run `npm install`.
5. Run `npm start`.

After the bot starts in your guild, Discord should register `/live` and `/unlive` for that server.

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

## Optional environment variables

- `GUILD_ID`
- `LIVE_ROLE_DURATION_MS`

## Render setup

This repo includes `render.yaml`. On Render:

1. Create a new Worker Service from this repo.
2. Confirm the build command is `npm install`.
3. Confirm the start command is `npm start`.
4. Set `DISCORD_BOT_TOKEN` in Render environment variables.
5. Set `LIVE_NOW_ROLE_ID` to the role you want `/live` to assign.
6. Optionally set `LIVE_ROLE_DURATION_MS` if you want a different expiry time than 2 hours.
7. Update any other role or channel IDs if needed.

## Notes

The timed removal uses an in-memory timer. That keeps the bot simple and works well for local testing and basic Render usage, but if the bot restarts before the timer finishes, that pending removal will be lost.

This bot does not DM unverified users or post reminder spam. It only manages roles and logs `/live` and `/unlive` actions.

This bot does not expose an HTTP server, so a Render worker is the right fit.
