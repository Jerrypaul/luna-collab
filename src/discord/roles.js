const { splitMessage } = require("../utils/chunk");

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

async function fetchGuildResources(guild, config) {
  const verifiedRole = guild.roles.cache.get(config.verifiedRoleId) || await guild.roles.fetch(config.verifiedRoleId).catch(() => null);
  const unverifiedRole = guild.roles.cache.get(config.unverifiedRoleId) || await guild.roles.fetch(config.unverifiedRoleId).catch(() => null);
  const liveNowRole = guild.roles.cache.get(config.liveNowRoleId) || await guild.roles.fetch(config.liveNowRoleId).catch(() => null);
  const logChannel = guild.channels.cache.get(config.logChannelId) || await guild.channels.fetch(config.logChannelId).catch(() => null);
  const liveNowChannel = config.liveNowChannelId
    ? (guild.channels.cache.get(config.liveNowChannelId) || await guild.channels.fetch(config.liveNowChannelId).catch(() => null))
    : null;

  return { verifiedRole, unverifiedRole, liveNowRole, logChannel, liveNowChannel };
}

module.exports = {
  sendLogSafe,
  removeRoleSafe,
  addRoleSafe,
  assignUnverifiedRole,
  fetchGuildResources,
};
