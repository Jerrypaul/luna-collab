const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");

const DISCORD_MESSAGE_LIMIT = 2000;

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

const config = {
  botToken: parseRequiredId("DISCORD_BOT_TOKEN"),
  guildId: parseOptionalId("GUILD_ID"),
  verifiedRoleId: parseRequiredId("VERIFIED_ROLE_ID"),
  unverifiedRoleId: parseRequiredId("UNVERIFIED_ROLE_ID"),
  liveNowRoleId: parseRequiredId("LIVE_NOW_ROLE_ID"),
  logChannelId: parseRequiredId("LOG_CHANNEL_ID"),
  liveRoleDurationMs: parseDurationMs("LIVE_ROLE_DURATION_MS", 2 * 60 * 60 * 1000),
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

const slashCommandDefinitions = [
  {
    name: "live",
    description: 'Add the "Live Now" role to yourself.',
  },
  {
    name: "unlive",
    description: 'Remove the "Live Now" role from yourself.',
  },
];

function getTargetGuilds() {
  const guilds = [...client.guilds.cache.values()];
  if (!config.guildId) {
    return guilds;
  }

  return guilds.filter((guild) => guild.id === config.guildId);
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

  // This lightweight timer works well locally and on Render, but it does not survive restarts.
  const timer = setTimeout(async () => {
    liveRoleRemovalTimers.delete(timerKey);

    try {
      const refreshedMember = await member.guild.members.fetch(member.id);
      if (!refreshedMember.roles.cache.has(role.id)) {
        return;
      }

      const removed = await removeRoleSafe(
        refreshedMember,
        role,
        "Live Now role expired",
      );

      if (removed) {
        await sendLogSafe(
          logChannel,
          `Removed ${role} from ${refreshedMember} after the live timer expired.`,
        );
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
      // Register as guild commands so test updates appear quickly.
      await guild.commands.set(slashCommandDefinitions);
      console.log(`Registered slash commands for guild "${guild.name}".`);
    } catch (error) {
      console.error(`Failed to register slash commands for guild "${guild.name}":`, error.message);
    }
  }
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
          const removed = await removeRoleSafe(
            member,
            unverifiedRole,
            "Startup scan: user already verified",
          );

          if (removed) {
            removedCount += 1;
          }
        }
      }

      console.log(
        `Scan complete for guild "${guild.name}". Removed unverified from ${removedCount} member(s).`,
      );
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
  await registerGuildCommands();
  await runStartupScan();
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

  // New members should start with the unverified role until Linked Roles adds verified.
  if (member.roles.cache.has(verifiedRole.id)) {
    return;
  }

  await assignUnverifiedRole(
    member,
    unverifiedRole,
    "Member joined server without verified role",
  );
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

  // Linked Roles adds verified; when that happens, remove unverified automatically.
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

  if (!["live", "unlive"].includes(interaction.commandName)) {
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }

  if (config.guildId && interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "This command is not enabled in this server.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  if (!member || !("roles" in member)) {
    await interaction.reply({
      content: "I could not load your member data. Please try again.",
      ephemeral: true,
    });
    return;
  }

  const { liveNowRole, logChannel } = await fetchGuildResources(interaction.guild);
  if (!liveNowRole) {
    await interaction.reply({
      content: 'The "Live Now" role is not configured correctly.',
      ephemeral: true,
    });
    return;
  }

  const botMember = interaction.guild.members.me;
  if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await interaction.reply({
      content: "I need the Manage Roles permission to do that.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "live") {
    if (member.roles.cache.has(liveNowRole.id)) {
      await interaction.reply({
        content: 'You already have the "Live Now" role.',
        ephemeral: true,
      });
      return;
    }

    const added = await addRoleSafe(member, liveNowRole, "User used /live");
    if (!added) {
      await interaction.reply({
        content: 'I could not add the "Live Now" role. Check my role position and permissions.',
        ephemeral: true,
      });
      return;
    }

    scheduleLiveRoleRemoval(member, liveNowRole, logChannel);

    const durationHours = config.liveRoleDurationMs / (60 * 60 * 1000);
    await interaction.reply({
      content: `You now have the "Live Now" role. It will be removed automatically in ${durationHours} hour(s).`,
      ephemeral: true,
    });

    await sendLogSafe(
      logChannel,
      `Assigned ${liveNowRole} to ${interaction.user} via /live. It will be removed automatically in ${durationHours} hour(s).`,
    );

    return;
  }

  if (!member.roles.cache.has(liveNowRole.id)) {
    await interaction.reply({
      content: 'You do not currently have the "Live Now" role.',
      ephemeral: true,
    });
    return;
  }

  clearLiveRoleRemovalTimer(interaction.guild.id, member.id);

  const removed = await removeRoleSafe(member, liveNowRole, "User used /unlive");
  if (!removed) {
    await interaction.reply({
      content: 'I could not remove the "Live Now" role. Check my role position and permissions.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: 'The "Live Now" role has been removed.',
    ephemeral: true,
  });

  await sendLogSafe(
    logChannel,
    `Removed ${liveNowRole} from ${interaction.user} via /unlive.`,
  );
});

client.login(config.botToken).catch((error) => {
  console.error("Failed to log in to Discord:", error);
  process.exitCode = 1;
});
