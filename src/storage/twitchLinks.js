const { Pool } = require("pg");
const { normalizeTwitchLogin } = require("../utils/twitch");

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

function createTwitchLinksStore(config) {
  const state = {
    enabled: Boolean(config.databaseUrl),
    ready: false,
    pool: config.databaseUrl
      ? new Pool({
          connectionString: config.databaseUrl,
          ssl: config.databaseSsl === "false" ? false : { rejectUnauthorized: false },
        })
      : null,
  };

  async function ensureReady() {
    if (!state.enabled) {
      return false;
    }

    if (state.ready) {
      return true;
    }

    await state.pool.query(`
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

    await state.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS twitch_links_twitch_login_unique
      ON twitch_links (LOWER(twitch_login))
    `);

    state.ready = true;
    console.log("Postgres storage ready for Twitch links.");
    return true;
  }

  async function getByTwitchLogin(twitchLogin) {
    if (!await ensureReady()) {
      return null;
    }

    const result = await state.pool.query(
      `
        SELECT discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
        FROM twitch_links
        WHERE LOWER(twitch_login) = LOWER($1)
      `,
      [normalizeTwitchLogin(twitchLogin)],
    );

    return mapTwitchLinkRow(result.rows[0] || null);
  }

  async function getByDiscordUserId(discordUserId) {
    if (!await ensureReady()) {
      return null;
    }

    const result = await state.pool.query(
      `
        SELECT discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
        FROM twitch_links
        WHERE discord_user_id = $1
      `,
      [String(discordUserId)],
    );

    return mapTwitchLinkRow(result.rows[0] || null);
  }

  async function upsert(discordUserId, twitchLogin, approved = false) {
    await ensureReady();

    const result = await state.pool.query(
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
        VALUES ($1, $2, $3, NOW(), NOW(), CASE WHEN $3 THEN NOW() ELSE NULL END, CASE WHEN $3 THEN NULL ELSE NOW() END)
        ON CONFLICT (discord_user_id)
        DO UPDATE SET
          twitch_login = EXCLUDED.twitch_login,
          approved = EXCLUDED.approved,
          updated_at = NOW(),
          approved_at = CASE WHEN EXCLUDED.approved THEN NOW() ELSE NULL END,
          denied_at = CASE WHEN EXCLUDED.approved THEN NULL ELSE NOW() END
        RETURNING discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
      `,
      [String(discordUserId), normalizeTwitchLogin(twitchLogin), approved],
    );

    return mapTwitchLinkRow(result.rows[0]);
  }
  async function remove(discordUserId) {
    await ensureReady();

    const result = await state.pool.query(
      `
        DELETE FROM twitch_links
        WHERE discord_user_id = $1
        RETURNING discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
      `,
      [String(discordUserId)],
    );

    return mapTwitchLinkRow(result.rows[0] || null);
  }

  async function setApproval(discordUserId, approved) {
    await ensureReady();

    const result = await state.pool.query(
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

    return mapTwitchLinkRow(result.rows[0] || null);
  }

  async function getApprovedStreamersMap() {
    if (!await ensureReady()) {
      return {};
    }

    const result = await state.pool.query(`
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

  async function listPending() {
    if (!await ensureReady()) {
      return [];
    }

    const result = await state.pool.query(`
      SELECT discord_user_id, twitch_login, approved, created_at, updated_at, approved_at, denied_at
      FROM twitch_links
      WHERE approved = FALSE
      ORDER BY updated_at ASC, created_at ASC
    `);

    return result.rows.map(mapTwitchLinkRow);
  }

  return {
    ensureReady,
    getByDiscordUserId,
    getByTwitchLogin,
    upsert,
    remove,
    setApproval,
    getApprovedStreamersMap,
    listPending,
    isConfigured: () => state.enabled,
  };
}

module.exports = {
  createTwitchLinksStore,
};
