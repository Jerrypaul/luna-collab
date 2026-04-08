const { Client, Events, GatewayIntentBits, Partials } = require("discord.js");
const { loadConfig } = require("./config");
const { createTwitchLinksStore } = require("./storage/twitchLinks");
const { createTwitchApi } = require("./twitch/api");
const { createTwitchPoller } = require("./twitch/poller");
const {
  addRoleSafe,
  assignUnverifiedRole,
  clearLiveRoleRemovalTimer,
  fetchGuildResources,
  removeRoleSafe,
  sendLogSafe,
} = require("./discord/roles");
const { createCommandHandlers } = require("./discord/commands");

const config = loadConfig();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember, Partials.User],
});

let startupScanPromise = null;
let startupScanCompleted = false;
const liveRoleRemovalTimers = new Map();

const twitchState = {
  enabled: false,
  accessToken: null,
  accessTokenExpiresAt: 0,
  pollIntervalHandle: null,
  pollInFlight: false,
  offlineCounts: new Map(),
  liveDiscordIds: new Set(),
  livePosts: new Map(),
  livePostsPrimed: false,
};

function getTargetGuilds() {
  const guilds = [...client.guilds.cache.values()];
  if (!config.guildId) {
    return guilds;
  }

  return guilds.filter((guild) => guild.id === config.guildId);
}

function getLiveRoleTimerKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function clearManualLiveRoleTimer(guildId, userId) {
  const timerKey = getLiveRoleTimerKey(guildId, userId);
  const existingTimer = liveRoleRemovalTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    liveRoleRemovalTimers.delete(timerKey);
  }
}

function scheduleLiveRoleRemoval(member, role, logChannel) {
  const timerKey = getLiveRoleTimerKey(member.guild.id, member.id);
  clearManualLiveRoleTimer(member.guild.id, member.id);

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

const twitchLinksStore = createTwitchLinksStore(config);
const twitchApi = createTwitchApi(config, twitchState);
const twitchPoller = createTwitchPoller({
  client,
  config,
  twitchState,
  twitchLinksStore,
  twitchApi,
  fetchGuildResources,
  addRoleSafe,
  removeRoleSafe,
  sendLogSafe,
});
const commandHandlers = createCommandHandlers({
  config,
  twitchLinksStore,
  twitchApi,
  twitchPoller,
  fetchGuildResources,
  addRoleSafe,
  removeRoleSafe,
  sendLogSafe,
  scheduleLiveRoleRemoval,
  clearLiveRoleRemovalTimer: clearManualLiveRoleTimer,
});

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
      const { verifiedRole, unverifiedRole } = await fetchGuildResources(guild, config);
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
  await twitchLinksStore.ensureReady().catch((error) => {
    console.error("Failed to initialize Postgres storage:", error.message);
  });
  await commandHandlers.registerGuildCommands(client);
  await runStartupScan();
  await twitchPoller.startPolling();
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) {
    return;
  }

  if (config.guildId && member.guild.id !== config.guildId) {
    return;
  }

  const { verifiedRole, unverifiedRole } = await fetchGuildResources(member.guild, config);
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

  const { verifiedRole, unverifiedRole } = await fetchGuildResources(newMember.guild, config);
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
    clearManualLiveRoleTimer(newMember.guild.id, newMember.id);
  }
});

client.on(Events.InteractionCreate, commandHandlers.handleInteraction);

client.login(config.botToken).catch((error) => {
  console.error("Failed to log in to Discord:", error);
  process.exitCode = 1;
});
