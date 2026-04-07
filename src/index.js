const { Pool } = require("pg");
const {
  ApplicationCommandOptionType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");

const DISCORD_MESSAGE_LIMIT = 2000;
const TWITCH_HELIX_BASE_URL = "https://api.twitch.tv/helix";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_API_CHUNK_SIZE = 100;
const TWITCH_DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const TWITCH_OFFLINE_REMOVAL_THRESHOLD = 2;
const TWITCH_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

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

function normalizeTwitchLogin(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/^@+/, "").toLowerCase();
}

function chunkArray(items, chunkSize) {
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function splitMessage(content, limit = DISCORD_MESSAGE_LIMIT) {
  if (content.length <= limit) {
    return [content];
  }

  const chunks = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}

function mapTwitchLinkRow(row) {
  if (!row) {
    return null;
  }

  return {
    discordUserId: String(row.discord_user_id),
    twitchLogin: String(row.twitch_login).toLowerCase(),
    approved: Boolean(row.approved),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    approvedAt: row.approved_at instanceof Date ? row.approved_at.toISOString() : row.approved_at,
    deniedAt: row.denied_at instanceof Date ? row.denied_at.toISOString() : row.denied_at,
  };
}

function formatApprovalStatus(link) {
  return link.approved ? "approved" : "pending approval";
}

const config = {
  botToken: parseRequiredId("DISCORD_BOT_TOKEN"),
  guildId: parseOptionalId("GUILD_ID"),
  verifiedRoleId: parseRequiredId("VERIFIED_ROLE_ID"),
  unverifiedRoleId: parseRequiredId("UNVERIFIED_ROLE_ID"),
  liveNowRoleId: parseRequiredId("LIVE_NOW_ROLE_ID"),
  logChannelId: parseRequiredId("LOG_CHANNEL_ID"),
  liveRoleDurationMs: parseDurationMs("LIVE_ROLE_DURATION_MS", 2 * 60 * 60 * 1000),
  twitchClientId: parseOptionalId("TWITCH_CLIENT_ID"),
  twitchClientSecret: parseOptionalId("TWITCH_CLIENT_SECRET"),
  twitchPollIntervalMs: parseDurationMs("TWITCH_POLL_INTERVAL_MS", TWITCH_DEFAULT_POLL_INTERVAL_MS),
  databaseUrl: parseOptionalId("DATABASE_URL"),
  databaseSsl: parseOptionalString("DATABASE_SSL", "true"),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

let startupScanPromise = null;
let startupScanCompleted = false;
const liveRoleRemovalTimers = new Map();

const databaseState = {
  enabled: Boolean(config.databaseUrl),
  ready: false,
  pool: config.databaseUrl
    ? new Pool({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl === "false" ? false : { rejectUnauthorized: false },
      })
    : null,
};

const twitchState = {
  enabled: false,
  accessToken: null,
  accessTokenExpiresAt: 0,
  pollIntervalHandle: null,
  pollInFlight: false,
  offlineCounts: new Map(),
  liveDiscordIds: new Set(),
};

const moderatorPermission = PermissionsBitField.Flags.ManageRoles;
const moderatorPermissionString = moderatorPermission.toString();

const slashCommandDefinitions = [
  {
    name: "live",
    description: 'Add the "Live Now" role to yourself.',
  },
  {
    name: "unlive",
    description: 'Remove the "Live Now" role from yourself.',
  },
  {
    name: "linktwitch",
    description: "Request linking your Discord account to a Twitch username.",
    options: [
      {
        name: "username",
        description: "Your Twitch login name.",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: "unlinktwitch",
    description: "Remove your current Twitch link.",
  },
  {
    name: "mytwitch",
    description: "View your current Twitch link and approval status.",
  },
  {
    name: "approvetwitch",
    description: "Approve a user's Twitch link for live role automation.",
    defaultMemberPermissions: moderatorPermissionString,
    options: [
      {
        name: "user",
        description: "The Discord user to approve.",
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
  {
    name: "denytwitch",
    description: "Deny or clear approval for a user's Twitch link.",
    defaultMemberPermissions: moderatorPermissionString,
    options: [
      {
        name: "user",
        description: "The Discord user to deny.",
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
  {
    name: "pendingtwitch",
    description: "List Twitch links that are still waiting for approval.",
    defaultMemberPermissions: moderatorPermissionString,
  },
];

function getTargetGuilds() {
  const guilds = [...client.guilds.cache.values()];
  if (!config.guildId) {
    return guilds;
  }

  return guilds.filter((guild) => guild.id === config.guildId);
}

function isTwitchConfigured() {
  return Boolean(config.twitchClientId && config.twitchClientSecret);
}

function isDatabaseConfigured() {
  return databaseState.enabled;
}

function canUseModeratorCommands(interaction) {
  return Boolean(interaction.memberPermissions?.has(moderatorPermission));
}

async function sendLogSafe(logChannel, content) {
  if (!logChannel || !logChannel.isTextBased()) {
    return;
  }

  for (const chunk of splitMessage(content)) {
    try {
      await logChannel.send(chunk);
    } catch (error) {
      console.error("Failed to send log message:", error.message);
      return;
    }
  }
}

async function removeRoleSafe(member, role, reason) {
  try {
    await member.roles.remove(role, reason);
    console.log(`Removed ${role.name} from ${member.displayName}`);
    return true;
  } catch (error) {
    console.error(`Failed to remove ${role.name} from ${member.displayName}:`, error.message);
    return false;
  }
}

async function addRoleSafe(member, role, reason) {
  try {
    await member.roles.add(role, reason);
    console.log(`Added ${role.name} to ${member.displayName}`);
    return true;
  } catch (error) {
    console.error(`Failed to add ${role.name} to ${member.displayName}:`, error.message);
    return false;
  }
}

async function assignUnverifiedRole(member, unverifiedRole, reason) {
  if (member.user.bot) {
    return false;
  }

  if (member.roles.cache.has(unverifiedRole.id)) {
    return false;
  }

  return addRoleSafe(member, unverifiedRole, reason);
}

function getLiveRoleTimerKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function clearLiveRoleRemovalTimer(guildId, userId) {
  const timerKey = getLiveRoleTimerKey(guildId, userId);
  const existingTimer = liveRoleRemovalTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    liveRoleRemovalTimers.delete(timerKey);
  }
}

function scheduleLiveRoleRemoval(member, role, logChannel) {
  const timerKey = getLiveRoleTimerKey(member.guild.id, member.id);
  clearLiveRoleRemovalTimer(member.guild.id, member.id);

  // Manual timeouts should not strip the role if Twitch still reports the streamer as live.
  const timer = setTimeout(async () => {
    liveRoleRemovalTimers.delete(timerKey);

    if (twitchState.liveDiscordIds.has(member.id)) {
      console.log(`Skipping manual timeout removal for ${member.id} because Twitch still reports them live.`);
      return;
    }

    try {
      const refreshedMember = await member.guild.members.fetch(member.id);
      if (!refreshedMember.roles.cache.has(role.id)) {
        return;
      }

      const removed = await removeRoleSafe(refreshedMember, role, "Live Now role expired");
      if (removed) {
        await sendLogSafe(logChannel, `Removed ${role} from ${refreshedMember} after the manual live timer expired.`);
      }
    } catch (error) {
      console.error(`Failed to process timed removal for ${member.id}:`, error.message);
    }
  }, config.liveRoleDurationMs);

  liveRoleRemovalTimers.set(timerKey, timer);
}

async function fetchGuildResources(guild) {
  const verifiedRole = guild.roles.cache.get(config.verifiedRoleId) || await guild.roles.fetch(config.verifiedRoleId).catch(() => null);
  const unverifiedRole = guild.roles.cache.get(config.unverifiedRoleId) || await guild.roles.fetch(config.unverifiedRoleId).catch(() => null);
  const liveNowRole = guild.roles.cache.get(config.liveNowRoleId) || await guild.roles.fetch(config.liveNowRoleId).catch(() => null);
  const logChannel = guild.channels.cache.get(config.logChannelId) || await guild.channels.fetch(config.logChannelId).catch(() => null);

  return { verifiedRole, unverifiedRole, liveNowRole, logChannel };
}

async function registerGuildCommands() {
  const targetGuilds = getTargetGuilds();

  for (const guild of targetGuilds) {
    try {
      await guild.commands.set(slashCommandDefinitions);
      console.log(`Registered slash commands for guild "${guild.name}".`);
    } catch (error) {
      console.error(`Failed to register slash commands for guild "${guild.name}":`, error.message);
    }
  }
}

async function ensureDatabaseReady() {
  if (!databaseState.enabled) {
    return false;
  }

  if (databaseState.ready) {
    return true;
  }

  await databaseState.pool.query(`
    CREATE TABLE IF NOT EXISTS twitch_links (
      discord_user_id TEXT PRIMARY KEY,
      twitch_login TEXT NOT NULL,
      approved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ NULL,
      denied_at TIMESTAMPTZ NULL
    )
  `);

  databaseState.ready = true;
  console.log("Postgres storage ready for Twitch links.");
  return true;
}

async function getTwitchLinkByDiscordUserId(discordUserId) {
  if (!await ensureDatabaseReady()) {
    return null;
  }

  const result = await databaseState.pool.query(
    `
      SELECT discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
      FROM twitch_links
      WHERE discord_user_id = $1
    `,
    [String(discordUserId)],
  );

  return mapTwitchLinkRow(result.rows[0] || null);
}

async function upsertTwitchLink(discordUserId, twitchLogin) {
  await ensureDatabaseReady();

  const result = await databaseState.pool.query(
    `
      INSERT INTO twitch_links (
        discord_user_id,
        twitch_login,
        approved,
        created_at,
        updated_at,
        approved_at,
        denied_at
      )
      VALUES ($1, $2, FALSE, NOW(), NOW(), NULL, NULL)
      ON CONFLICT (discord_user_id)
      DO UPDATE SET
        twitch_login = EXCLUDED.twitch_login,
        approved = FALSE,
        updated_at = NOW(),
        approved_at = NULL,
        denied_at = NULL
      RETURNING discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
    `,
    [String(discordUserId), normalizeTwitchLogin(twitchLogin)],
  );

  twitchState.offlineCounts.delete(String(discordUserId));
  twitchState.liveDiscordIds.delete(String(discordUserId));
  return mapTwitchLinkRow(result.rows[0]);
}

async function removeTwitchLink(discordUserId) {
  await ensureDatabaseReady();

  const result = await databaseState.pool.query(
    `
      DELETE FROM twitch_links
      WHERE discord_user_id = $1
      RETURNING discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
    `,
    [String(discordUserId)],
  );

  twitchState.offlineCounts.delete(String(discordUserId));
  twitchState.liveDiscordIds.delete(String(discordUserId));
  return mapTwitchLinkRow(result.rows[0] || null);
}

async function setTwitchLinkApproval(discordUserId, approved) {
  await ensureDatabaseReady();

  const result = await databaseState.pool.query(
    `
      UPDATE twitch_links
      SET
        approved = $2,
        updated_at = NOW(),
        approved_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
        denied_at = CASE WHEN $2 THEN NULL ELSE NOW() END
      WHERE discord_user_id = $1
      RETURNING discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
    `,
    [String(discordUserId), approved],
  );

  if (!approved) {
    twitchState.offlineCounts.delete(String(discordUserId));
    twitchState.liveDiscordIds.delete(String(discordUserId));
  }

  return mapTwitchLinkRow(result.rows[0] || null);
}

async function getApprovedTwitchStreamersMap() {
  if (!await ensureDatabaseReady()) {
    return {};
  }

  const result = await databaseState.pool.query(`
    SELECT discord_user_id, twitch_login
    FROM twitch_links
    WHERE approved = TRUE
  `);

  const streamersMap = {};
  for (const row of result.rows) {
    streamersMap[String(row.discord_user_id)] = String(row.twitch_login).toLowerCase();
  }

  return streamersMap;
}

async function fetchTwitchAppAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && twitchState.accessToken && twitchState.accessTokenExpiresAt > now) {
    return twitchState.accessToken;
  }

  if (!isTwitchConfigured()) {
    throw new Error("Twitch credentials are not configured.");
  }

  const body = new URLSearchParams({
    client_id: config.twitchClientId,
    client_secret: config.twitchClientSecret,
    grant_type: "client_credentials",
  });

  console.log("Fetching Twitch app access token...");

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Twitch token fetch failed (${response.status}): ${responseBody}`);
  }

  const payload = await response.json();
  twitchState.accessToken = payload.access_token;
  twitchState.accessTokenExpiresAt = Date.now() + (payload.expires_in * 1000) - TWITCH_TOKEN_REFRESH_BUFFER_MS;

  console.log("Twitch app access token fetched successfully.");
  return twitchState.accessToken;
}

async function twitchApiFetch(url, retryOnUnauthorized = true) {
  const accessToken = await fetchTwitchAppAccessToken();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": config.twitchClientId,
    },
  });

  if (response.status === 401 && retryOnUnauthorized) {
    console.warn("Twitch API returned 401. Refreshing app token and retrying once.");
    await fetchTwitchAppAccessToken(true);
    return twitchApiFetch(url, false);
  }

  return response;
}

async function validateTwitchLoginWithApi(twitchLogin) {
  const normalizedLogin = normalizeTwitchLogin(twitchLogin);
  if (!normalizedLogin) {
    return { ok: false, reason: "invalid_input" };
  }

  const url = new URL(`${TWITCH_HELIX_BASE_URL}/users`);
  url.searchParams.append("login", normalizedLogin);

  const response = await twitchApiFetch(url);
  if (response.status === 429) {
    console.warn("Twitch username validation hit rate limits.");
    return { ok: false, reason: "rate_limited" };
  }

  if (!response.ok) {
    const responseBody = await response.text();
    console.error(`Twitch user validation failed (${response.status}): ${responseBody}`);
    return { ok: false, reason: "api_error" };
  }

  const payload = await response.json();
  const user = payload.data?.[0];
  if (!user || typeof user.login !== "string") {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true, twitchLogin: user.login.toLowerCase() };
}

async function fetchTwitchLiveLogins(streamerMap) {
  const streamerEntries = Object.entries(streamerMap);
  const uniqueLogins = [...new Set(streamerEntries.map(([, login]) => login))];
  const loginChunks = chunkArray(uniqueLogins, TWITCH_API_CHUNK_SIZE);

  console.log(
    `Starting Twitch poll. Configured streamers: ${streamerEntries.length}. Unique logins: ${uniqueLogins.length}. Chunks: ${loginChunks.length}.`,
  );

  const liveLogins = new Set();

  for (const loginChunk of loginChunks) {
    const url = new URL(`${TWITCH_HELIX_BASE_URL}/streams`);
    for (const login of loginChunk) {
      url.searchParams.append("user_login", login);
    }

    const response = await twitchApiFetch(url);
    if (response.status === 429) {
      console.warn("Twitch API returned 429 rate limit. Skipping this poll cycle.");
      return null;
    }

    if (!response.ok) {
      const responseBody = await response.text();
      console.error(`Twitch Get Streams failed (${response.status}): ${responseBody}`);
      return null;
    }

    const payload = await response.json();
    for (const stream of payload.data || []) {
      if (typeof stream.user_login === "string") {
        liveLogins.add(stream.user_login.toLowerCase());
      }
    }
  }

  console.log(`Twitch poll complete. Live streamers found: ${liveLogins.size}.`);
  return liveLogins;
}

async function fetchConfiguredMembers(guild, discordUserIds) {
  const memberMap = new Map();
  const userIdChunks = chunkArray(discordUserIds, TWITCH_API_CHUNK_SIZE);

  for (const userIdChunk of userIdChunks) {
    try {
      const members = await guild.members.fetch({ user: userIdChunk, cache: true });
      for (const [memberId, member] of members) {
        memberMap.set(memberId, member);
      }
      continue;
    } catch (error) {
      console.error(`Failed to fetch a member chunk for guild "${guild.name}". Falling back to per-user fetches:`, error.message);
    }

    for (const userId of userIdChunk) {
      try {
        const member = await guild.members.fetch(userId);
        if (member) {
          memberMap.set(userId, member);
        }
      } catch {
        // Ignore missing members; reconciliation logs a summary count later.
      }
    }
  }

  return memberMap;
}

async function reconcileTwitchRolesForGuild(guild, streamerMap, liveLogins, aggregatedLiveDiscordIds) {
  const { liveNowRole, logChannel } = await fetchGuildResources(guild);
  if (!liveNowRole) {
    console.warn(`Missing Live Now role in guild "${guild.name}". Skipping Twitch sync.`);
    return;
  }

  const streamerEntries = Object.entries(streamerMap);
  const configuredDiscordIds = streamerEntries.map(([discordUserId]) => discordUserId);
  const memberMap = await fetchConfiguredMembers(guild, configuredDiscordIds);

  let addedCount = 0;
  let removedCount = 0;
  let missingMemberCount = 0;

  for (const [discordUserId, twitchLogin] of streamerEntries) {
    const member = memberMap.get(discordUserId);
    if (!member) {
      missingMemberCount += 1;
      continue;
    }

    const isLiveOnTwitch = liveLogins.has(twitchLogin);
    const hasLiveRole = member.roles.cache.has(liveNowRole.id);

    if (isLiveOnTwitch) {
      aggregatedLiveDiscordIds.add(discordUserId);
      twitchState.offlineCounts.delete(discordUserId);

      if (!hasLiveRole) {
        const added = await addRoleSafe(member, liveNowRole, "Twitch live detection: streamer is live");
        if (added) {
          addedCount += 1;
          await sendLogSafe(logChannel, `Assigned ${liveNowRole} to ${member} because Twitch reports them live.`);
        }
      }

      continue;
    }

    const nextOfflineCount = (twitchState.offlineCounts.get(discordUserId) || 0) + 1;
    twitchState.offlineCounts.set(discordUserId, nextOfflineCount);

    if (nextOfflineCount < TWITCH_OFFLINE_REMOVAL_THRESHOLD) {
      continue;
    }

    if (hasLiveRole) {
      const removed = await removeRoleSafe(member, liveNowRole, "Twitch live detection: streamer is offline");
      if (removed) {
        removedCount += 1;
        await sendLogSafe(logChannel, `Removed ${liveNowRole} from ${member} because Twitch reports them offline.`);
      }
    }
  }

  console.log(
    `Twitch sync complete for guild "${guild.name}". Added: ${addedCount}. Removed: ${removedCount}. Missing members: ${missingMemberCount}.`,
  );
}

async function runTwitchPollCycle() {
  if (!twitchState.enabled) {
    return;
  }

  if (twitchState.pollInFlight) {
    console.log("Skipping Twitch poll because the previous cycle is still running.");
    return;
  }

  twitchState.pollInFlight = true;

  try {
    const approvedStreamersMap = await getApprovedTwitchStreamersMap();
    const configuredStreamerCount = Object.keys(approvedStreamersMap).length;
    if (configuredStreamerCount === 0) {
      console.log("Skipping Twitch poll because there are no approved Twitch mappings.");
      twitchState.liveDiscordIds = new Set();
      return;
    }

    const liveLogins = await fetchTwitchLiveLogins(approvedStreamersMap);
    if (liveLogins === null) {
      return;
    }

    const aggregatedLiveDiscordIds = new Set();
    for (const guild of getTargetGuilds()) {
      await reconcileTwitchRolesForGuild(guild, approvedStreamersMap, liveLogins, aggregatedLiveDiscordIds);
    }

    twitchState.liveDiscordIds = aggregatedLiveDiscordIds;
  } catch (error) {
    console.error("Twitch poll cycle failed:", error.message);
  } finally {
    twitchState.pollInFlight = false;
  }
}

async function startTwitchPolling() {
  if (!isTwitchConfigured()) {
    console.log("Twitch auto-detection disabled: missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET.");
    return;
  }

  if (!await ensureDatabaseReady()) {
    console.log("Twitch auto-detection disabled: DATABASE_URL is not configured.");
    return;
  }

  twitchState.enabled = true;

  const approvedStreamersMap = await getApprovedTwitchStreamersMap();
  const configuredStreamerCount = Object.keys(approvedStreamersMap).length;
  console.log(`Twitch auto-detection enabled. Approved streamers: ${configuredStreamerCount}. Poll interval: ${config.twitchPollIntervalMs}ms.`);

  await runTwitchPollCycle();

  if (twitchState.pollIntervalHandle) {
    clearInterval(twitchState.pollIntervalHandle);
  }

  twitchState.pollIntervalHandle = setInterval(() => {
    runTwitchPollCycle().catch((error) => {
      console.error("Unexpected Twitch poller failure:", error.message);
    });
  }, config.twitchPollIntervalMs);
}

async function runStartupScan() {
  if (startupScanCompleted) {
    console.log("Startup scan already completed for this session. Skipping.");
    return;
  }

  if (startupScanPromise) {
    await startupScanPromise;
    return;
  }

  startupScanPromise = (async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log("Scanning members...");

    const targetGuilds = getTargetGuilds();
    if (targetGuilds.length === 0) {
      console.warn("No matching guilds found for this bot.");
    }

    for (const guild of targetGuilds) {
      const { verifiedRole, unverifiedRole } = await fetchGuildResources(guild);
      if (!verifiedRole || !unverifiedRole) {
        console.warn(`Missing required roles in guild "${guild.name}". Check your configured IDs.`);
        continue;
      }

      const members = await guild.members.fetch();
      let removedCount = 0;

      for (const member of members.values()) {
        if (member.user.bot) {
          continue;
        }

        const hasVerified = member.roles.cache.has(verifiedRole.id);
        const hasUnverified = member.roles.cache.has(unverifiedRole.id);

        if (hasVerified && hasUnverified) {
          const removed = await removeRoleSafe(member, unverifiedRole, "Startup scan: user already verified");
          if (removed) {
            removedCount += 1;
          }
        }
      }

      console.log(`Scan complete for guild "${guild.name}". Removed unverified from ${removedCount} member(s).`);
    }

    startupScanCompleted = true;
  })();

  try {
    await startupScanPromise;
  } finally {
    startupScanPromise = null;
  }
}

client.once(Events.ClientReady, async () => {
  await ensureDatabaseReady().catch((error) => {
    console.error("Failed to initialize Postgres storage:", error.message);
  });
  await registerGuildCommands();
  await runStartupScan();
  await startTwitchPolling();
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) {
    return;
  }

  if (config.guildId && member.guild.id !== config.guildId) {
    return;
  }

  const { verifiedRole, unverifiedRole } = await fetchGuildResources(member.guild);
  if (!verifiedRole || !unverifiedRole) {
    return;
  }

  if (member.roles.cache.has(verifiedRole.id)) {
    return;
  }

  await assignUnverifiedRole(member, unverifiedRole, "Member joined server without verified role");
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (newMember.user.bot) {
    return;
  }

  if (config.guildId && newMember.guild.id !== config.guildId) {
    return;
  }

  const { verifiedRole, unverifiedRole } = await fetchGuildResources(newMember.guild);
  if (!verifiedRole || !unverifiedRole) {
    return;
  }

  const hadVerified = oldMember.roles.cache.has(verifiedRole.id);
  const hasVerified = newMember.roles.cache.has(verifiedRole.id);
  const hasUnverified = newMember.roles.cache.has(unverifiedRole.id);
  const gainedVerified = hasVerified && !hadVerified;

  if (gainedVerified && hasUnverified) {
    await removeRoleSafe(newMember, unverifiedRole, "User verified via Linked Role");
  }

  if (oldMember.roles.cache.has(config.liveNowRoleId) && !newMember.roles.cache.has(config.liveNowRoleId)) {
    clearLiveRoleRemovalTimer(newMember.guild.id, newMember.id);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const supportedCommands = [
    "live",
    "unlive",
    "linktwitch",
    "unlinktwitch",
    "mytwitch",
    "approvetwitch",
    "denytwitch",
    "pendingtwitch",
  ];

  if (!supportedCommands.includes(interaction.commandName)) {
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
    return;
  }

  if (config.guildId && interaction.guildId !== config.guildId) {
    await interaction.reply({ content: "This command is not enabled in this server.", ephemeral: true });
    return;
  }

  const member = interaction.member;
  if (!member || !("roles" in member)) {
    await interaction.reply({ content: "I could not load your member data. Please try again.", ephemeral: true });
    return;
  }

  const { liveNowRole, logChannel } = await fetchGuildResources(interaction.guild);

  if (["live", "unlive"].includes(interaction.commandName)) {
    if (!liveNowRole) {
      await interaction.reply({ content: 'The "Live Now" role is not configured correctly.', ephemeral: true });
      return;
    }

    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      await interaction.reply({ content: "I need the Manage Roles permission to do that.", ephemeral: true });
      return;
    }

    if (interaction.commandName === "live") {
      if (member.roles.cache.has(liveNowRole.id)) {
        await interaction.reply({ content: 'You already have the "Live Now" role.', ephemeral: true });
        return;
      }

      const added = await addRoleSafe(member, liveNowRole, "User used /live");
      if (!added) {
        await interaction.reply({ content: 'I could not add the "Live Now" role. Check my role position and permissions.', ephemeral: true });
        return;
      }

      scheduleLiveRoleRemoval(member, liveNowRole, logChannel);

      const durationHours = config.liveRoleDurationMs / (60 * 60 * 1000);
      await interaction.reply({ content: `You now have the "Live Now" role. It will be removed automatically in ${durationHours} hour(s).`, ephemeral: true });
      await sendLogSafe(logChannel, `Assigned ${liveNowRole} to ${interaction.user} via /live. It will be removed automatically in ${durationHours} hour(s).`);
      return;
    }

    if (!member.roles.cache.has(liveNowRole.id)) {
      await interaction.reply({ content: 'You do not currently have the "Live Now" role.', ephemeral: true });
      return;
    }

    clearLiveRoleRemovalTimer(interaction.guild.id, member.id);
    const removed = await removeRoleSafe(member, liveNowRole, "User used /unlive");
    if (!removed) {
      await interaction.reply({ content: 'I could not remove the "Live Now" role. Check my role position and permissions.', ephemeral: true });
      return;
    }

    await interaction.reply({ content: 'The "Live Now" role has been removed.', ephemeral: true });
    await sendLogSafe(logChannel, `Removed ${liveNowRole} from ${interaction.user} via /unlive.`);
    return;
  }

  if (!isDatabaseConfigured()) {
    await interaction.reply({ content: "Twitch linking is currently unavailable because Postgres is not configured.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "mytwitch") {
    const existingLink = await getTwitchLinkByDiscordUserId(interaction.user.id);
    if (!existingLink) {
      await interaction.reply({ content: "You do not currently have a linked Twitch account.", ephemeral: true });
      return;
    }

    await interaction.reply({ content: `Linked Twitch account: \`${existingLink.twitchLogin}\` (${formatApprovalStatus(existingLink)}).`, ephemeral: true });
    return;
  }

  if (interaction.commandName === "linktwitch") {
    if (!isTwitchConfigured()) {
      await interaction.reply({ content: "Twitch linking is currently unavailable because Twitch API credentials are not configured.", ephemeral: true });
      return;
    }

    const requestedLogin = interaction.options.getString("username", true);
    const normalizedLogin = normalizeTwitchLogin(requestedLogin);
    if (!normalizedLogin) {
      await interaction.reply({ content: "Please provide a valid Twitch username.", ephemeral: true });
      return;
    }

    const validationResult = await validateTwitchLoginWithApi(normalizedLogin);
    if (!validationResult.ok) {
      const validationMessages = {
        invalid_input: "Please provide a valid Twitch username.",
        not_found: "That Twitch username was not found.",
        rate_limited: "Twitch validation is temporarily rate limited. Please try again in a moment.",
        api_error: "I could not validate that Twitch username right now. Please try again later.",
      };

      await interaction.reply({ content: validationMessages[validationResult.reason] || "I could not validate that Twitch username right now.", ephemeral: true });
      return;
    }

    const existingLink = await getTwitchLinkByDiscordUserId(interaction.user.id);
    if (existingLink && existingLink.twitchLogin === validationResult.twitchLogin) {
      await interaction.reply({ content: `Your Twitch account is already linked as \`${existingLink.twitchLogin}\` and is currently ${formatApprovalStatus(existingLink)}.`, ephemeral: true });
      return;
    }

    const savedLink = await upsertTwitchLink(interaction.user.id, validationResult.twitchLogin);
    await interaction.reply({ content: `Saved Twitch link \`${savedLink.twitchLogin}\`. It is pending moderator approval before automatic live detection will use it.`, ephemeral: true });
    await sendLogSafe(logChannel, `Twitch link requested by ${interaction.user}: \`${savedLink.twitchLogin}\` (pending approval).`);
    return;
  }

  if (interaction.commandName === "unlinktwitch") {
    const removedLink = await removeTwitchLink(interaction.user.id);
    if (!removedLink) {
      await interaction.reply({ content: "You do not currently have a linked Twitch account.", ephemeral: true });
      return;
    }

    await interaction.reply({ content: `Removed your Twitch link for \`${removedLink.twitchLogin}\`.`, ephemeral: true });
    await sendLogSafe(logChannel, `Twitch link removed by ${interaction.user}: \`${removedLink.twitchLogin}\`.`);
    return;
  }

  if (!canUseModeratorCommands(interaction)) {
    await interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "pendingtwitch") {
    const pendingLinks = await listPendingTwitchLinks();
    if (pendingLinks.length === 0) {
      await interaction.reply({ content: "There are no Twitch links waiting for approval.", ephemeral: true });
      return;
    }

    const lines = ["**Pending Twitch approvals:**"];
    for (const pendingLink of pendingLinks) {
      lines.push(`- <@${pendingLink.discordUserId}> -> \`${pendingLink.twitchLogin}\``);
    }

    const chunks = splitMessage(lines.join("\n"));
    await interaction.reply({ content: chunks[0], ephemeral: true });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, ephemeral: true });
    }
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const existingLink = await getTwitchLinkByDiscordUserId(targetUser.id);
  if (!existingLink) {
    await interaction.reply({ content: `${targetUser} does not currently have a linked Twitch account.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === "approvetwitch") {
    if (existingLink.approved) {
      await interaction.reply({ content: `${targetUser} is already approved for \`${existingLink.twitchLogin}\`.`, ephemeral: true });
      return;
    }

    const approvedLink = await setTwitchLinkApproval(targetUser.id, true);
    await interaction.reply({ content: `Approved Twitch link \`${approvedLink.twitchLogin}\` for ${targetUser}.`, ephemeral: true });
    await sendLogSafe(logChannel, `Approved Twitch link for ${targetUser}: \`${approvedLink.twitchLogin}\`.`);

    if (twitchState.enabled) {
      await runTwitchPollCycle();
    }

    return;
  }

  const deniedLink = await setTwitchLinkApproval(targetUser.id, false);
  await interaction.reply({ content: `Denied Twitch link \`${deniedLink.twitchLogin}\` for ${targetUser}.`, ephemeral: true });
  await sendLogSafe(logChannel, `Denied Twitch link for ${targetUser}: \`${deniedLink.twitchLogin}\`.`);
});

client.login(config.botToken).catch((error) => {
  console.error("Failed to log in to Discord:", error);
  process.exitCode = 1;
});


