const { ApplicationCommandOptionType, PermissionsBitField } = require("discord.js");
const { splitMessage } = require("../utils/chunk");
const { formatApprovalStatus, normalizeTwitchLogin } = require("../utils/twitch");

function createCommandHandlers({
  config,
  twitchLinksStore,
  twitchApi,
  twitchPoller,
  fetchGuildResources,
  addRoleSafe,
  removeRoleSafe,
  sendLogSafe,
  scheduleLiveRoleRemoval,
  clearLiveRoleRemovalTimer,
}) {
  const moderatorPermission = PermissionsBitField.Flags.ManageRoles;
  const moderatorPermissionString = moderatorPermission.toString();

  const slashCommandDefinitions = [
    { name: "live", description: 'Add the "Live Now" role to yourself.' },
    { name: "unlive", description: 'Remove the "Live Now" role from yourself.' },
    {
      name: "linktwitch",
      description: "Request linking your Discord account to a Twitch username.",
      options: [{ name: "username", description: "Your Twitch login name.", type: ApplicationCommandOptionType.String, required: true }],
    },
    { name: "unlinktwitch", description: "Remove your current Twitch link." },
    { name: "mytwitch", description: "View your current Twitch link and approval status." },
    {
      name: "approvetwitch",
      description: "Approve a user's Twitch link for live role automation.",
      defaultMemberPermissions: moderatorPermissionString,
      options: [{ name: "user", description: "The Discord user to approve.", type: ApplicationCommandOptionType.User, required: true }],
    },
    {
      name: "denytwitch",
      description: "Deny or clear approval for a user's Twitch link.",
      defaultMemberPermissions: moderatorPermissionString,
      options: [{ name: "user", description: "The Discord user to deny.", type: ApplicationCommandOptionType.User, required: true }],
    },
    {
      name: "pendingtwitch",
      description: "List Twitch links that are still waiting for approval.",
      defaultMemberPermissions: moderatorPermissionString,
    },
  ];

  function canUseModeratorCommands(interaction) {
    return Boolean(interaction.memberPermissions?.has(moderatorPermission));
  }

  function getTargetGuilds(client) {
    const guilds = [...client.guilds.cache.values()];
    if (!config.guildId) {
      return guilds;
    }

    return guilds.filter((guild) => guild.id === config.guildId);
  }

  async function registerGuildCommands(client) {
    const targetGuilds = getTargetGuilds(client);

    for (const guild of targetGuilds) {
      try {
        await guild.commands.set(slashCommandDefinitions);
        console.log(`Registered slash commands for guild "${guild.name}".`);
      } catch (error) {
        console.error(`Failed to register slash commands for guild "${guild.name}":`, error.message);
      }
    }
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const supportedCommands = slashCommandDefinitions.map((command) => command.name);
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

    const { verifiedRole, liveNowRole, logChannel } = await fetchGuildResources(interaction.guild, config);

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

    if (!twitchLinksStore.isConfigured()) {
      await interaction.reply({ content: "Twitch linking is currently unavailable because Postgres is not configured.", ephemeral: true });
      return;
    }

    if (interaction.commandName === "mytwitch") {
      const existingLink = await twitchLinksStore.getByDiscordUserId(interaction.user.id);
      if (!existingLink) {
        await interaction.reply({ content: "You do not currently have a linked Twitch account.", ephemeral: true });
        return;
      }

      await interaction.reply({ content: `Linked Twitch account: \`${existingLink.twitchLogin}\` (${formatApprovalStatus(existingLink)}).`, ephemeral: true });
      return;
    }

    if (interaction.commandName === "linktwitch") {
      if (!verifiedRole || !member.roles.cache.has(verifiedRole.id)) {
        await interaction.reply({
          content: "You must complete Linked Roles verification before linking your Twitch.\nGo to Server Settings -> Linked Roles -> Apply / Verify",
          ephemeral: true,
        });
        return;
      }

      if (!twitchApi.isConfigured()) {
        await interaction.reply({ content: "Twitch linking is currently unavailable because Twitch API credentials are not configured.", ephemeral: true });
        return;
      }

      const requestedLogin = interaction.options.getString("username", true);
      const normalizedLogin = normalizeTwitchLogin(requestedLogin);
      if (!normalizedLogin) {
        await interaction.reply({ content: "Please provide a valid Twitch username.", ephemeral: true });
        return;
      }

      const validationResult = await twitchApi.validateLogin(normalizedLogin);
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

      const existingLink = await twitchLinksStore.getByDiscordUserId(interaction.user.id);
      if (existingLink && existingLink.twitchLogin === validationResult.twitchLogin) {
        await interaction.reply({ content: `Your Twitch account is already linked as \`${existingLink.twitchLogin}\` and is currently ${formatApprovalStatus(existingLink)}.`, ephemeral: true });
        return;
      }

      const conflictingLink = await twitchLinksStore.getByTwitchLogin(validationResult.twitchLogin);
      if (conflictingLink && conflictingLink.discordUserId !== interaction.user.id) {
        await interaction.reply({ content: "That Twitch account is already linked to another Discord member. Please contact a moderator if you believe this is incorrect.", ephemeral: true });
        return;
      }

      const requiresApproval = config.twitchLinkRequireApproval;
      const savedLink = await twitchLinksStore.upsert(interaction.user.id, validationResult.twitchLogin, !requiresApproval);

      if (requiresApproval) {
        await interaction.reply({ content: `Saved Twitch link \`${savedLink.twitchLogin}\`. It is pending moderator approval before automatic live detection will use it.`, ephemeral: true });
        await sendLogSafe(logChannel, `Twitch link requested by ${interaction.user}: \`${savedLink.twitchLogin}\` (pending approval).`);
        return;
      }

      await interaction.reply({ content: `Saved Twitch link \`${savedLink.twitchLogin}\`. Automatic live detection is now enabled for your account.`, ephemeral: true });
      await sendLogSafe(logChannel, `Twitch link auto-approved for ${interaction.user}: \`${savedLink.twitchLogin}\`.`);
      if (twitchPoller) {
        await twitchPoller.runPollCycle();
      }
      return;
    }
    if (interaction.commandName === "unlinktwitch") {
      const removedLink = await twitchLinksStore.remove(interaction.user.id);
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
      const pendingLinks = await twitchLinksStore.listPending();
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
    const existingLink = await twitchLinksStore.getByDiscordUserId(targetUser.id);
    if (!existingLink) {
      await interaction.reply({ content: `${targetUser} does not currently have a linked Twitch account.`, ephemeral: true });
      return;
    }

    if (interaction.commandName === "approvetwitch") {
      if (existingLink.approved) {
        await interaction.reply({ content: `${targetUser} is already approved for \`${existingLink.twitchLogin}\`.`, ephemeral: true });
        return;
      }

      const approvedLink = await twitchLinksStore.setApproval(targetUser.id, true);
      await interaction.reply({ content: `Approved Twitch link \`${approvedLink.twitchLogin}\` for ${targetUser}.`, ephemeral: true });
      await sendLogSafe(logChannel, `Approved Twitch link for ${targetUser}: \`${approvedLink.twitchLogin}\`.`);
      if (twitchPoller) {
        await twitchPoller.runPollCycle();
      }
      return;
    }

    const deniedLink = await twitchLinksStore.setApproval(targetUser.id, false);
    await interaction.reply({ content: `Denied Twitch link \`${deniedLink.twitchLogin}\` for ${targetUser}.`, ephemeral: true });
    await sendLogSafe(logChannel, `Denied Twitch link for ${targetUser}: \`${deniedLink.twitchLogin}\`.`);
  }

  return {
    slashCommandDefinitions,
    registerGuildCommands,
    handleInteraction,
  };
}

module.exports = {
  createCommandHandlers,
};
