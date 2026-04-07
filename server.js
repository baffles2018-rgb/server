const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = String(process.env.API_KEY || "").trim();
const DB_PATH = path.resolve(process.env.DB_PATH || "./donations.db");

if (!API_KEY) {
  console.error("Missing API_KEY environment variable.");
  process.exit(1);
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS donations (
    id TEXT PRIMARY KEY,
    fromUserId INTEGER NOT NULL,
    fromUsername TEXT NOT NULL,
    toUserId INTEGER NOT NULL,
    toUsername TEXT NOT NULL,
    amount INTEGER NOT NULL,
    gameId INTEGER NOT NULL DEFAULT 0,
    placeId INTEGER NOT NULL DEFAULT 0,
    purchaseId TEXT,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_donations_timestamp ON donations(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_donations_gameId ON donations(gameId);
  CREATE INDEX IF NOT EXISTS idx_donations_fromUserId ON donations(fromUserId);
  CREATE INDEX IF NOT EXISTS idx_donations_toUserId ON donations(toUserId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_purchaseId ON donations(purchaseId);
`);

function requireApiKey(req, res, next) {
  const providedKey = String(req.header("x-api-key") || "").trim();

  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  }

  return response.json();
}

async function getUserGames(userId) {
  let cursor = "";
  const allGames = [];

  while (true) {
    const url =
      `https://games.roproxy.com/v2/users/${encodeURIComponent(userId)}/games` +
      `?accessFilter=2&limit=50&sortOrder=Asc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

    const data = await fetchJson(url);
    const items = Array.isArray(data.data) ? data.data : [];
    allGames.push(...items);

    if (!data.nextPageCursor) {
      break;
    }

    cursor = data.nextPageCursor;
  }

  return allGames;
}

async function getUniversePasses(universeId) {
  let cursor = "";
  const allPasses = [];

  while (true) {
    const url =
      `https://apis.roproxy.com/game-passes/v1/universes/${encodeURIComponent(universeId)}/game-passes` +
      `?limit=100&sortOrder=Asc` +
      (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : "");

    const data = await fetchJson(url);

    const items =
      Array.isArray(data.gamePasses) ? data.gamePasses :
      Array.isArray(data.data) ? data.data :
      [];

    allPasses.push(...items);

    const nextToken = data.nextPageToken || data.nextPageCursor || "";
    if (!nextToken) {
      break;
    }

    cursor = nextToken;
  }

  return allPasses;
}

function startOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfWeekUTC() {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday start
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

function filterByPeriod(items, period) {
  if (period === "alltime") {
    return items;
  }

  let cutoff = null;

  if (period === "today") {
    cutoff = startOfTodayUTC().toISOString();
  } else if (period === "week") {
    cutoff = startOfWeekUTC().toISOString();
  }

  if (!cutoff) {
    return items;
  }

  return items.filter(item => item.timestamp >= cutoff);
}

function buildDonationLeaderboard(donations, type) {
  const map = new Map();

  for (const donation of donations) {
    const userId = type === "donated" ? donation.fromUserId : donation.toUserId;
    const username = type === "donated" ? donation.fromUsername : donation.toUsername;
    const amount = Number(donation.amount) || 0;

    if (!map.has(userId)) {
      map.set(userId, {
        userId,
        username,
        amount: 0
      });
    }

    map.get(userId).amount += amount;
  }

  return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
}

function getAllDonations(gameId) {
  if (Number.isFinite(gameId)) {
    return db.prepare(`
      SELECT *
      FROM donations
      WHERE gameId = ?
      ORDER BY timestamp DESC
    `).all(gameId);
  }

  return db.prepare(`
    SELECT *
    FROM donations
    ORDER BY timestamp DESC
  `).all();
}

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "Backend is running"
  });
});

app.get("/roblox-passes", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Missing userId"
      });
    }

    const games = await getUserGames(userId);

    const seenUniverseIds = new Set();
    const seenPassIds = new Set();
    const passItems = [];

    for (const game of games) {
      const universeId = Number(game.id || game.rootPlace?.universeId || game.universeId);

      if (!Number.isFinite(universeId) || seenUniverseIds.has(universeId)) {
        continue;
      }

      seenUniverseIds.add(universeId);

      try {
        const passes = await getUniversePasses(universeId);

        for (const pass of passes) {
          const passId = Number(
            pass.id ||
            pass.gamePassId ||
            pass.passId ||
            (typeof pass.path === "string" ? pass.path.split("/").pop() : 0)
          );

          if (!Number.isFinite(passId) || seenPassIds.has(passId)) {
            continue;
          }

          seenPassIds.add(passId);
          passItems.push({ PassId: passId });
        }
      } catch (err) {
        console.error(`Failed to fetch passes for universe ${universeId}:`, err.message);
      }
    }

    passItems.sort((a, b) => a.PassId - b.PassId);

    return res.json({
      success: true,
      items: passItems
    });
  } catch (error) {
    console.error("roblox-passes error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch passes"
    });
  }
});

app.post("/donations", requireApiKey, (req, res) => {
  try {
    const {
      fromUserId,
      fromUsername,
      toUserId,
      toUsername,
      amount,
      gameId,
      placeId,
      purchaseId
    } = req.body || {};

    const donorId = Number(fromUserId);
    const receiverId = Number(toUserId);
    const donationAmount = Number(amount);
    const parsedGameId = Number(gameId || 0);
    const parsedPlaceId = Number(placeId || 0);
    const normalizedPurchaseId = String(purchaseId || "").trim();

    if (
      !Number.isFinite(donorId) ||
      !Number.isFinite(receiverId) ||
      !Number.isFinite(donationAmount) ||
      donationAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid donation data"
      });
    }

    if (!normalizedPurchaseId) {
      return res.status(400).json({
        success: false,
        message: "Missing purchaseId"
      });
    }

    const existing = db.prepare(`
      SELECT id
      FROM donations
      WHERE purchaseId = ?
      LIMIT 1
    `).get(normalizedPurchaseId);

    if (existing) {
      return res.json({
        success: true,
        duplicate: true,
        message: "Donation already recorded"
      });
    }

    const donation = {
      id: `don_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
      fromUserId: donorId,
      fromUsername: String(fromUsername || "Unknown"),
      toUserId: receiverId,
      toUsername: String(toUsername || "Unknown"),
      amount: donationAmount,
      gameId: Number.isFinite(parsedGameId) ? parsedGameId : 0,
      placeId: Number.isFinite(parsedPlaceId) ? parsedPlaceId : 0,
      purchaseId: normalizedPurchaseId,
      timestamp: new Date().toISOString()
    };

    db.prepare(`
      INSERT INTO donations (
        id,
        fromUserId,
        fromUsername,
        toUserId,
        toUsername,
        amount,
        gameId,
        placeId,
        purchaseId,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      donation.id,
      donation.fromUserId,
      donation.fromUsername,
      donation.toUserId,
      donation.toUsername,
      donation.amount,
      donation.gameId,
      donation.placeId,
      donation.purchaseId,
      donation.timestamp
    );

    return res.json({
      success: true,
      donation
    });
  } catch (error) {
    console.error("POST /donations error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to save donation"
    });
  }
});

app.get("/donations/recent", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const gameId = req.query.gameId ? Number(req.query.gameId) : null;

    let items = getAllDonations(gameId);
    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return res.json({
      success: true,
      items: items.slice(0, limit)
    });
  } catch (error) {
    console.error("GET /donations/recent error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent donations"
    });
  }
});

app.get("/leaderboards/donators/:period", (req, res) => {
  try {
    const period = String(req.params.period || "").toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const gameId = req.query.gameId ? Number(req.query.gameId) : null;

    if (!["today", "week", "alltime"].includes(period)) {
      return res.status(400).json({
        success: false,
        message: "Invalid period"
      });
    }

    let items = getAllDonations(gameId);
    items = filterByPeriod(items, period);

    const leaderboard = buildDonationLeaderboard(items, "donated");

    return res.json({
      success: true,
      period,
      items: leaderboard.slice(0, limit)
    });
  } catch (error) {
    console.error("GET /leaderboards/donators/:period error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch donator leaderboard"
    });
  }
});

app.get("/leaderboards/raised/:period", (req, res) => {
  try {
    const period = String(req.params.period || "").toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const gameId = req.query.gameId ? Number(req.query.gameId) : null;

    if (!["today", "week", "alltime"].includes(period)) {
      return res.status(400).json({
        success: false,
        message: "Invalid period"
      });
    }

    let items = getAllDonations(gameId);
    items = filterByPeriod(items, period);

    const leaderboard = buildDonationLeaderboard(items, "raised");

    return res.json({
      success: true,
      period,
      items: leaderboard.slice(0, limit)
    });
  } catch (error) {
    console.error("GET /leaderboards/raised/:period error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch raised leaderboard"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  console.log(`Using SQLite database at: ${DB_PATH}`);
});
