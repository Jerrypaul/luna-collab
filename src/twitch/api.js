const { chunkArray } = require("../utils/chunk");
const { normalizeTwitchLogin } = require("../utils/twitch");

const TWITCH_HELIX_BASE_URL = "https://api.twitch.tv/helix";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_API_CHUNK_SIZE = 100;
const TWITCH_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

function createTwitchApi(config, twitchState) {
  function isConfigured() {
    return Boolean(config.twitchClientId && config.twitchClientSecret);
  }

  async function fetchAppAccessToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && twitchState.accessToken && twitchState.accessTokenExpiresAt > now) {
      return twitchState.accessToken;
    }

    if (!isConfigured()) {
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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

  async function apiFetch(url, retryOnUnauthorized = true) {
    const accessToken = await fetchAppAccessToken();
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": config.twitchClientId,
      },
    });

    if (response.status === 401 && retryOnUnauthorized) {
      console.warn("Twitch API returned 401. Refreshing app token and retrying once.");
      await fetchAppAccessToken(true);
      return apiFetch(url, false);
    }

    return response;
  }

  async function validateLogin(twitchLogin) {
    const normalizedLogin = normalizeTwitchLogin(twitchLogin);
    if (!normalizedLogin) {
      return { ok: false, reason: "invalid_input" };
    }

    const url = new URL(`${TWITCH_HELIX_BASE_URL}/users`);
    url.searchParams.append("login", normalizedLogin);

    const response = await apiFetch(url);
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

  async function fetchLiveStreams(streamerMap) {
    const streamerEntries = Object.entries(streamerMap);
    const uniqueLogins = [...new Set(streamerEntries.map(([, login]) => login))];
    const loginChunks = chunkArray(uniqueLogins, TWITCH_API_CHUNK_SIZE);

    console.log(
      `Starting Twitch poll. Configured streamers: ${streamerEntries.length}. Unique logins: ${uniqueLogins.length}. Chunks: ${loginChunks.length}.`,
    );

    const liveStreams = new Map();

    for (const loginChunk of loginChunks) {
      const url = new URL(`${TWITCH_HELIX_BASE_URL}/streams`);
      for (const login of loginChunk) {
        url.searchParams.append("user_login", login);
      }

      const response = await apiFetch(url);
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
          const normalized = stream.user_login.toLowerCase();
          liveStreams.set(normalized, {
            twitchLogin: normalized,
            displayName: typeof stream.user_name === "string" ? stream.user_name : normalized,
            gameName: typeof stream.game_name === "string" && stream.game_name ? stream.game_name : "an unknown game",
          });
        }
      }
    }

    console.log(`Twitch poll complete. Live streamers found: ${liveStreams.size}.`);
    return liveStreams;
  }

  return {
    isConfigured,
    validateLogin,
    fetchLiveStreams,
  };
}

module.exports = {
  createTwitchApi,
};
