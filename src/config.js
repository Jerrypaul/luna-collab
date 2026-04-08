const TWITCH_DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

function parseRequiredId(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseOptionalId(name) {
  return process.env[name] || null;
}

function parseOptionalString(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value;
}

function parseDurationMs(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
}

function loadConfig() {
  return {
    botToken: parseRequiredId("DISCORD_BOT_TOKEN"),
    guildId: parseOptionalId("GUILD_ID"),
    verifiedRoleId: parseRequiredId("VERIFIED_ROLE_ID"),
    unverifiedRoleId: parseRequiredId("UNVERIFIED_ROLE_ID"),
    liveNowRoleId: parseRequiredId("LIVE_NOW_ROLE_ID"),
    liveNowChannelId: parseOptionalId("LIVE_NOW_CHANNEL_ID"),
    logChannelId: parseRequiredId("LOG_CHANNEL_ID"),
    liveRoleDurationMs: parseDurationMs("LIVE_ROLE_DURATION_MS", 2 * 60 * 60 * 1000),
    twitchClientId: parseOptionalId("TWITCH_CLIENT_ID"),
    twitchClientSecret: parseOptionalId("TWITCH_CLIENT_SECRET"),
    twitchPollIntervalMs: parseDurationMs("TWITCH_POLL_INTERVAL_MS", TWITCH_DEFAULT_POLL_INTERVAL_MS),
    databaseUrl: parseOptionalId("DATABASE_URL"),
    databaseSsl: parseOptionalString("DATABASE_SSL", "true"),
  };
}

module.exports = {
  TWITCH_DEFAULT_POLL_INTERVAL_MS,
  loadConfig,
};
