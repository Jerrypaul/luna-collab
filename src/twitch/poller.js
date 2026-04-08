const { chunkArray } = require("../utils/chunk");

const TWITCH_API_CHUNK_SIZE = 100;
const TWITCH_OFFLINE_REMOVAL_THRESHOLD = 2;

function createTwitchPoller({
  client,
  config,
  twitchState,
  twitchLinksStore,
  twitchApi,
  fetchGuildResources,
  addRoleSafe,
  removeRoleSafe,
  sendLogSafe,
}) {
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

  async function deleteLiveNowPostSafe(liveNowChannel, twitchLogin, livePostState) {
    if (!config.liveNowChannelId) {
      return;
    }

    if (!liveNowChannel || !liveNowChannel.isTextBased()) {
      console.error(`Live now channel is missing or invalid for Twitch live post cleanup. Channel ID: ${config.liveNowChannelId}`);
      return;
    }

    if (!livePostState || typeof livePostState !== "string") {
      return;
    }

    try {
      const message = await liveNowChannel.messages.fetch(livePostState);
      if (!message) {
        return;
      }

      await message.delete();
      console.log(`Deleted live now post for ${twitchLogin}.`);
    } catch (error) {
      console.error(`Failed to delete live now post for ${twitchLogin}:`, error.message);
    }
  }

  async function sendLiveNowPostSafe(liveNowChannel, liveStream) {
    if (!config.liveNowChannelId) {
      return null;
    }

    if (!liveNowChannel || !liveNowChannel.isTextBased()) {
      console.error(`Live now channel is missing or invalid for Twitch live posts. Channel ID: ${config.liveNowChannelId}`);
      return null;
    }

    const message = [
      `<@&1483931014349852976> ${liveStream.displayName} is now live! \uD83D\uDD34`,
      "",
      `They're currently playing **${liveStream.gameName}!**`,
      "",
      `Consider leaving a lurk to support them over at https://twitch.tv/${liveStream.twitchLogin} \uD83D\uDC4B\uD83C\uDFFB`,
    ].join("\n");

    try {
      const sentMessage = await liveNowChannel.send(message);
      console.log(`Sent live now post for ${liveStream.twitchLogin}.`);
      return sentMessage.id;
    } catch (error) {
      console.error(`Failed to send live now post for ${liveStream.twitchLogin}:`, error.message);
      return null;
    }
  }

  async function reconcileGuild(guild, streamerMap, liveStreams, aggregatedLiveDiscordIds) {
    const { liveNowRole, logChannel, liveNowChannel } = await fetchGuildResources(guild, config);
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

      const liveStream = liveStreams.get(twitchLogin);
      const isLiveOnTwitch = Boolean(liveStream);
      const hasLiveRole = member.roles.cache.has(liveNowRole.id);

      if (isLiveOnTwitch) {
        aggregatedLiveDiscordIds.add(discordUserId);
        twitchState.offlineCounts.delete(discordUserId);

        if (!twitchState.livePosts.has(twitchLogin)) {
          if (twitchState.livePostsPrimed) {
            const livePostId = await sendLiveNowPostSafe(liveNowChannel, liveStream);
            twitchState.livePosts.set(twitchLogin, livePostId || true);
          } else {
            twitchState.livePosts.set(twitchLogin, true);
          }
        }

        if (!hasLiveRole) {
          const added = await addRoleSafe(member, liveNowRole, "Twitch live detection: streamer is live");
          if (added) {
            addedCount += 1;
            await sendLogSafe(logChannel, `Assigned ${liveNowRole} to ${member} because Twitch reports them live.`);
          }
        }

        continue;
      }

      if (twitchState.livePosts.has(twitchLogin)) {
        const livePostState = twitchState.livePosts.get(twitchLogin);
        await deleteLiveNowPostSafe(liveNowChannel, twitchLogin, livePostState);
        twitchState.livePosts.delete(twitchLogin);
        console.log(`Cleared live post state for ${twitchLogin} because Twitch reports them offline.`);
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

    console.log(`Twitch sync complete for guild "${guild.name}". Added: ${addedCount}. Removed: ${removedCount}. Missing members: ${missingMemberCount}.`);
  }

  function getTargetGuilds() {
    const guilds = [...client.guilds.cache.values()];
    if (!config.guildId) {
      return guilds;
    }

    return guilds.filter((guild) => guild.id === config.guildId);
  }

  async function runPollCycle() {
    if (!twitchState.enabled) {
      return;
    }

    if (twitchState.pollInFlight) {
      console.log("Skipping Twitch poll because the previous cycle is still running.");
      return;
    }

    twitchState.pollInFlight = true;

    try {
      const approvedStreamersMap = await twitchLinksStore.getApprovedStreamersMap();
      const configuredStreamerCount = Object.keys(approvedStreamersMap).length;
      if (configuredStreamerCount === 0) {
        console.log("Skipping Twitch poll because there are no approved Twitch mappings.");
        twitchState.liveDiscordIds = new Set();
        return;
      }

      const liveStreams = await twitchApi.fetchLiveStreams(approvedStreamersMap);
      if (liveStreams === null) {
        return;
      }

      const aggregatedLiveDiscordIds = new Set();
      for (const guild of getTargetGuilds()) {
        await reconcileGuild(guild, approvedStreamersMap, liveStreams, aggregatedLiveDiscordIds);
      }

      twitchState.liveDiscordIds = aggregatedLiveDiscordIds;
      twitchState.livePostsPrimed = true;
    } catch (error) {
      console.error("Twitch poll cycle failed:", error.message);
    } finally {
      twitchState.pollInFlight = false;
    }
  }

  async function startPolling() {
    if (!twitchApi.isConfigured()) {
      console.log("Twitch auto-detection disabled: missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET.");
      return;
    }

    if (!await twitchLinksStore.ensureReady()) {
      console.log("Twitch auto-detection disabled: DATABASE_URL is not configured.");
      return;
    }

    twitchState.enabled = true;

    const approvedStreamersMap = await twitchLinksStore.getApprovedStreamersMap();
    const configuredStreamerCount = Object.keys(approvedStreamersMap).length;
    console.log(`Twitch auto-detection enabled. Approved streamers: ${configuredStreamerCount}. Poll interval: ${config.twitchPollIntervalMs}ms.`);

    await runPollCycle();

    if (twitchState.pollIntervalHandle) {
      clearInterval(twitchState.pollIntervalHandle);
    }

    twitchState.pollIntervalHandle = setInterval(() => {
      runPollCycle().catch((error) => {
        console.error("Unexpected Twitch poller failure:", error.message);
      });
    }, config.twitchPollIntervalMs);
  }

  return {
    runPollCycle,
    startPolling,
  };
}

module.exports = {
  createTwitchPoller,
};
