const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = String(process.env.API_KEY || "").trim();
const DB_PATH = path.resolve(process.env.DB_PATH || "./donations.db");

const CATALOG_BASE_URL = String(process.env.CATALOG_BASE_URL || "https://catalog.roproxy.com").replace(/\/+$/, "");
const ECONOMY_BASE_URL = String(process.env.ECONOMY_BASE_URL || "https://economy.roproxy.com").replace(/\/+$/, "");
const GAMES_BASE_URL = String(process.env.GAMES_BASE_URL || "https://games.roproxy.com").replace(/\/+$/, "");
const PASSES_BASE_URL = String(process.env.PASSES_BASE_URL || "https://apis.roproxy.com").replace(/\/+$/, "");
const GROUPS_BASE_URL = String(process.env.GROUPS_BASE_URL || "https://groups.roproxy.com").replace(/\/+$/, "");
const THUMBNAILS_BASE_URL = String(process.env.THUMBNAILS_BASE_URL || "https://thumbnails.roproxy.com").replace(/\/+$/, "");

const ROBLOX_CREATOR_NAME = String(process.env.ROBLOX_CREATOR_NAME || "Roblox").trim();
const ROBLOX_CREATOR_ID = Number(process.env.ROBLOX_CREATOR_ID || 1);

const CATALOG_CACHE_TTL_MS = 30 * 1000;
const ITEM_CACHE_TTL_MS = 2 * 60 * 1000;
const LIMITED_PRICE_CACHE_TTL_MS = 45 * 1000;
const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;

const catalogCache = new Map();
const itemCache = new Map();
const priceCache = new Map();
const groupCache = new Map();

const DANCES = [
  {
    Name: "Dance 1",
    AnimationId: "rbxassetid://507771019",
    Category: "Basic",
    Rarity: "Common",
    Price: 0,
    Speed: 1
  },
  {
    Name: "Dance 2",
    AnimationId: "rbxassetid://507776043",
    Category: "Basic",
    Rarity: "Common",
    Price: 0,
    Speed: 1
  },
  {
    Name: "Dance 3",
    AnimationId: "rbxassetid://507777268",
    Category: "Basic",
    Rarity: "Common",
    Price: 0,
    Speed: 1
  },
  {
    Name: "Robot",
    AnimationId: "rbxassetid://507776720",
    Category: "Basic",
    Rarity: "Common",
    Price: 0,
    Speed: 1
  },
  {
    Name: "Cheer",
    AnimationId: "rbxassetid://507770677",
    Category: "Basic",
    Rarity: "Common",
    Price: 0,
    Speed: 1
  },
  {
    Name: "Wave",
    AnimationId: "rbxassetid://507770239",
    Category: "Basic",
    Rarity: "Common",
    Price: 0,
    Speed: 1
  }
];

if (!global.fetch) {
  console.error("This backend requires Node 18+ because it uses the built-in fetch API.");
  process.exit(1);
}

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
    donationMethod TEXT NOT NULL DEFAULT 'Legacy',
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_donations_timestamp ON donations(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_donations_gameId ON donations(gameId);
  CREATE INDEX IF NOT EXISTS idx_donations_fromUserId ON donations(fromUserId);
  CREATE INDEX IF NOT EXISTS idx_donations_toUserId ON donations(toUserId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_purchaseId ON donations(purchaseId);
`);

try {
  db.exec("ALTER TABLE donations ADD COLUMN donationMethod TEXT NOT NULL DEFAULT 'Legacy'");
} catch (error) {
  if (!String(error.message || "").toLowerCase().includes("duplicate column")) {
    console.error("Unable to migrate donationMethod column:", error.message);
  }
}

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const {
    timeoutMs = 10000,
    retries = 1
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 CatalogBackend/2.0",
          "Accept": "application/json"
        },
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timer);
      lastError = error;

      if (attempt < retries) {
        await sleep(300);
      }
    }
  }

  throw lastError;
}

function getCache(map, key) {
  const hit = map.get(key);
  if (!hit) {
    return null;
  }

  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }

  return hit.value;
}

function setCache(map, key, value, ttlMs) {
  map.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function sanitizeString(value, maxLen = 80) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLen);
}

function normalizeBool(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function normalizeSortType(sort) {
  const value = String(sort || "Relevance").toLowerCase();
  if (value === "pricelow") return 3;
  if (value === "pricehigh") return 4;
  return 0;
}

function getFallbackKeyword(category) {
  const c = String(category || "all").toLowerCase();

  if (c === "accessories") return "hat horns accessory";
  if (c === "clothing") return "shirt pants clothing";
  if (c === "body") return "face head body";
  if (c === "animations") return "animation emote";
  if (c === "bundles") return "bundle";
  return "avatar";
}

function isRobloxCreator(item) {
  const creatorName = String(
    item?.creatorName ||
    item?.creator?.name ||
    item?.creator?.creatorName ||
    ""
  ).trim();

  const creatorId = Number(
    item?.creatorTargetId ??
    item?.creatorId ??
    item?.creator?.id ??
    item?.creator?.creatorTargetId ??
    0
  );

  if (creatorId > 0 && Number.isFinite(ROBLOX_CREATOR_ID) && creatorId === ROBLOX_CREATOR_ID) {
    return true;
  }

  return creatorName.toLowerCase() === ROBLOX_CREATOR_NAME.toLowerCase();
}

function detectLimited(item) {
  if (
    item?.collectibleItemId ||
    item?.collectibleProductId ||
    item?.isLimited === true ||
    item?.isLimitedUnique === true
  ) {
    return true;
  }

  const restrictions = Array.isArray(item?.itemRestrictions) ? item.itemRestrictions : [];
  for (const restriction of restrictions) {
    if (String(restriction || "").toLowerCase().includes("limited")) {
      return true;
    }
  }

  const priceStatus = String(item?.priceStatus || "").toLowerCase();
  return priceStatus.includes("limited");
}

function normalizeItemType(item) {
  const rawType = String(
    item?.itemType ||
    item?.itemTypeDisplayName ||
    (item?.bundleType ? "Bundle" : "Asset")
  ).trim();

  return rawType || "Asset";
}

function normalizeThumbnail(item) {
  const explicit =
    item?.thumbnailUrl ||
    item?.thumbnail ||
    item?.imageUrl ||
    item?.itemImageId;

  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }

  const id = Number(item?.id || item?.itemId || 0);
  if (!Number.isFinite(id) || id <= 0) {
    return "";
  }

  const itemType = normalizeItemType(item);
  if (itemType.toLowerCase() === "bundle") {
    return `rbxthumb://type=BundleThumbnail&id=${id}&w=420&h=420`;
  }

  return `rbxthumb://type=Asset&id=${id}&w=420&h=420`;
}

function firstFiniteNumber(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (value === null || value === undefined || value === "") {
      continue;
    }

    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }

  return null;
}

function formatRobux(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "Price unavailable";
  }

  if (n <= 0) {
    return "Free";
  }

  return `${Math.floor(n).toLocaleString("en-US")} R$`;
}

function buildPriceInfo(item, options = {}) {
  const isLimited = options.isLimited ?? detectLimited(item);
  const rawStatus = String(item?.priceStatus || item?.PriceStatus || "").trim();
  const statusLower = rawStatus.toLowerCase();

  const liveResalePrice = firstFiniteNumber(item, [
    "CollectibleLowestResalePrice",
    "collectibleLowestResalePrice",
    "lowestResalePrice",
    "LowestResalePrice",
    "lowestAvailableResalePrice",
    "LowestAvailableResalePrice",
    "lowestAvailablePrice",
    "LowestAvailablePrice",
    "bestPrice",
    "BestPrice"
  ]);

  if (isLimited) {
    if (liveResalePrice !== null && liveResalePrice > 0) {
      return {
        Price: Math.floor(liveResalePrice),
        PriceText: formatRobux(liveResalePrice),
        PriceStatus: "Limited resale",
        PriceSource: "live-resale-field",
        PriceUpdatedAt: new Date().toISOString(),
        IsForSale: true
      };
    }

    const possibleLowestPrice = firstFiniteNumber(item, [
      "lowestPrice",
      "LowestPrice"
    ]);

    if (possibleLowestPrice !== null && possibleLowestPrice > 0) {
      return {
        Price: Math.floor(possibleLowestPrice),
        PriceText: formatRobux(possibleLowestPrice),
        PriceStatus: "Limited resale",
        PriceSource: "catalog-lowest-price",
        PriceUpdatedAt: new Date().toISOString(),
        IsForSale: true
      };
    }

    return {
      Price: null,
      PriceText: "Price unavailable",
      PriceStatus: "Price unavailable",
      PriceSource: "limited-unavailable",
      PriceUpdatedAt: new Date().toISOString(),
      IsForSale: false
    };
  }

  const normalPrice = firstFiniteNumber(item, [
    "price",
    "Price",
    "priceInRobux",
    "PriceInRobux",
    "lowestPrice",
    "LowestPrice"
  ]);

  const explicitlyForSale = item?.isForSale === true || item?.IsForSale === true;
  const explicitlyOffsale =
    item?.isForSale === false ||
    item?.IsForSale === false ||
    statusLower.includes("off") ||
    statusLower.includes("unavailable") ||
    statusLower.includes("not for sale");

  if (explicitlyOffsale && normalPrice === null) {
    return {
      Price: null,
      PriceText: "Offsale",
      PriceStatus: rawStatus || "Offsale",
      PriceSource: "offsale",
      PriceUpdatedAt: new Date().toISOString(),
      IsForSale: false
    };
  }

  if (normalPrice !== null) {
    const price = Math.max(0, Math.floor(normalPrice));
    return {
      Price: price,
      PriceText: formatRobux(price),
      PriceStatus: rawStatus || (price === 0 ? "Free" : "On sale"),
      PriceSource: "catalog-price",
      PriceUpdatedAt: new Date().toISOString(),
      IsForSale: explicitlyForSale || !explicitlyOffsale
    };
  }

  return {
    Price: null,
    PriceText: explicitlyOffsale ? "Offsale" : "Price unavailable",
    PriceStatus: rawStatus || (explicitlyOffsale ? "Offsale" : "Price unavailable"),
    PriceSource: explicitlyOffsale ? "offsale" : "unavailable",
    PriceUpdatedAt: new Date().toISOString(),
    IsForSale: false
  };
}

function normalizeDescription(item) {
  return String(item?.description || item?.itemDescription || "").trim();
}

function normalizeCreatorName(item) {
  return String(
    item?.creatorName ||
    item?.creator?.name ||
    item?.creator?.creatorName ||
    "Unknown"
  ).trim() || "Unknown";
}

function normalizeAssetType(item) {
  return String(
    item?.assetType ||
    item?.assetTypeName ||
    item?.assetTypeDisplayName ||
    ""
  ).trim();
}

function normalizeBundleType(item) {
  return String(item?.bundleType || item?.bundleTypeName || "").trim();
}

function buildTags(item) {
  const tags = [];

  if (detectLimited(item)) {
    tags.push("LIMITED");
  }

  if (isRobloxCreator(item)) {
    tags.push("ROBLOX");
  } else {
    tags.push("UGC");
  }

  return tags.length > 0 ? tags.join(" • ") : "NONE";
}

function normalizeCatalogItem(item) {
  const id = Number(item?.id || item?.itemId || 0);
  const itemType = normalizeItemType(item);
  const isLimited = detectLimited(item);
  const priceInfo = buildPriceInfo(item, { isLimited });

  return {
    Id: id,
    ItemType: itemType,
    Name: String(item?.name || item?.itemName || "Item").trim() || "Item",
    Description: normalizeDescription(item),
    CreatorName: normalizeCreatorName(item),
    CreatorTargetId: Number(
      item?.creatorTargetId ??
      item?.creatorId ??
      item?.creator?.id ??
      item?.creator?.creatorTargetId ??
      0
    ) || 0,
    Price: priceInfo.Price,
    PriceText: priceInfo.PriceText,
    PriceStatus: priceInfo.PriceStatus,
    PriceSource: priceInfo.PriceSource,
    PriceUpdatedAt: priceInfo.PriceUpdatedAt,
    IsForSale: priceInfo.IsForSale,
    Thumbnail: normalizeThumbnail(item),
    AssetType: normalizeAssetType(item),
    BundleType: normalizeBundleType(item),
    IsRobloxCreated: isRobloxCreator(item),
    IsLimited: isLimited,
    Tags: buildTags(item)
  };
}

function dedupeById(items) {
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const id = Number(item?.Id || 0);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) {
      continue;
    }

    seen.add(id);
    out.push(item);
  }

  return out;
}

function mergePriceInfo(item, priceInfo) {
  if (!item || !priceInfo) {
    return item;
  }

  return {
    ...item,
    Price: priceInfo.Price,
    PriceText: priceInfo.PriceText,
    PriceStatus: priceInfo.PriceStatus,
    PriceSource: priceInfo.PriceSource,
    PriceUpdatedAt: priceInfo.PriceUpdatedAt,
    IsForSale: priceInfo.IsForSale
  };
}

async function fetchLimitedResalePrice(assetId) {
  const id = toPositiveInt(assetId, 0);
  if (!id) {
    return {
      Price: null,
      PriceText: "Price unavailable",
      PriceStatus: "Price unavailable",
      PriceSource: "invalid-id",
      PriceUpdatedAt: new Date().toISOString(),
      IsForSale: false
    };
  }

  const cacheKey = `limited_resale_${id}`;
  const cached = getCache(priceCache, cacheKey);
  if (cached) {
    console.log(`[CatalogPrice] using cached price itemId=${id} price=${cached.PriceText}`);
    return cached;
  }

  const url = new URL(`${ECONOMY_BASE_URL}/v1/assets/${encodeURIComponent(id)}/resellers`);
  url.searchParams.set("limit", "10");

  try {
    const data = await fetchJson(url.toString(), { timeoutMs: 5000, retries: 0 });
    const rows = Array.isArray(data.data) ? data.data : [];
    const prices = rows
      .map(row => Number(row?.price ?? row?.Price ?? row?.sellerPrice ?? 0))
      .filter(price => Number.isFinite(price) && price > 0);

    if (prices.length > 0) {
      const lowest = Math.min(...prices);
      const result = {
        Price: Math.floor(lowest),
        PriceText: formatRobux(lowest),
        PriceStatus: "Limited resale",
        PriceSource: "economy-resellers",
        PriceUpdatedAt: new Date().toISOString(),
        IsForSale: true
      };

      console.log(`[CatalogPrice] itemId=${id} limited=true price=${result.PriceText} source=${result.PriceSource}`);
      setCache(priceCache, cacheKey, result, LIMITED_PRICE_CACHE_TTL_MS);
      return result;
    }

    const result = {
      Price: null,
      PriceText: "No resellers",
      PriceStatus: "No resellers",
      PriceSource: "economy-resellers-empty",
      PriceUpdatedAt: new Date().toISOString(),
      IsForSale: false
    };

    console.log(`[CatalogPrice] limited price unavailable itemId=${id} reason=no-resellers`);
    setCache(priceCache, cacheKey, result, LIMITED_PRICE_CACHE_TTL_MS);
    return result;
  } catch (error) {
    const result = {
      Price: null,
      PriceText: "Price unavailable",
      PriceStatus: "Price unavailable",
      PriceSource: "economy-resellers-error",
      PriceUpdatedAt: new Date().toISOString(),
      IsForSale: false
    };

    console.warn(`[CatalogPrice] limited price unavailable itemId=${id} reason=${error.message}`);
    setCache(priceCache, cacheKey, result, 15 * 1000);
    return result;
  }
}

async function enrichLimitedItemPrice(item) {
  if (!item || !item.IsLimited) {
    return item;
  }

  if (String(item.ItemType || "").toLowerCase() === "bundle") {
    return item;
  }

  const livePrice = await fetchLimitedResalePrice(item.Id);
  return mergePriceInfo(item, livePrice);
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;

      output[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return output;
}

async function enrichLimitedPrices(items) {
  return mapWithConcurrency(items, 6, async item => {
    try {
      return await enrichLimitedItemPrice(item);
    } catch (error) {
      console.warn(`[CatalogPrice] stale/unavailable price kept itemId=${item?.Id} reason=${error.message}`);
      return item;
    }
  });
}

function categoryMatches(item, category) {
  const c = String(category || "all").toLowerCase();
  if (c === "all") {
    return true;
  }

  const assetType = String(item.AssetType || "").toLowerCase();
  const itemType = String(item.ItemType || "").toLowerCase();
  const bundleType = String(item.BundleType || "").toLowerCase();
  const haystack = `${String(item.Name || "").toLowerCase()} ${String(item.Description || "").toLowerCase()}`;

  if (c === "accessories") {
    if (!assetType) {
      return itemType !== "bundle";
    }

    return [
      "hat",
      "hairaccessory",
      "faceaccessory",
      "neckaccessory",
      "shoulderaccessory",
      "frontaccessory",
      "backaccessory",
      "waistaccessory"
    ].includes(assetType);
  }

  if (c === "clothing") {
    if (!assetType) {
      return haystack.includes("shirt") || haystack.includes("pants") || haystack.includes("clothing");
    }

    return [
      "shirt",
      "pants",
      "tshirt",
      "classicshirt",
      "classicpants",
      "classictshirt"
    ].includes(assetType);
  }

  if (c === "body") {
    if (!assetType) {
      return haystack.includes("face") || haystack.includes("head") || haystack.includes("body");
    }

    return [
      "face",
      "head",
      "torso",
      "leftarm",
      "rightarm",
      "leftleg",
      "rightleg"
    ].includes(assetType);
  }

  if (c === "animations") {
    if (!assetType) {
      return haystack.includes("animation") || haystack.includes("emote") || haystack.includes("dance");
    }

    return [
      "runanimation",
      "walkanimation",
      "jumpanimation",
      "fallanimation",
      "climbanimation",
      "idleanimation",
      "swimanimation",
      "poseanimation",
      "emoteanimation"
    ].includes(assetType);
  }

  if (c === "bundles") {
    if (itemType !== "bundle") {
      return false;
    }

    if (!bundleType) {
      return true;
    }

    return ["bodyparts", "animations", "characters"].includes(bundleType);
  }

  return true;
}

async function searchCatalogPage({ keyword, sort, limit, cursor, includeOffSale }) {
  const url = new URL(`${CATALOG_BASE_URL}/v1/search/items/details`);
  url.searchParams.set("Keyword", keyword);
  url.searchParams.set("Limit", String(limit));
  url.searchParams.set("SortType", String(normalizeSortType(sort)));
  url.searchParams.set("IncludeNotForSale", includeOffSale ? "true" : "false");
  url.searchParams.set("SalesTypeFilter", "1");

  if (cursor) {
    url.searchParams.set("Cursor", cursor);
  }

  return fetchJson(url.toString(), { timeoutMs: 9000, retries: 1 });
}

async function searchCatalog({ search, category, sort, page, pageSize, robloxOnly }) {
  const requestedPage = toPositiveInt(page, 1);
  const safePageSize = Math.max(1, Math.min(60, toPositiveInt(pageSize, 30)));
  const keyword = sanitizeString(search || "", 80) || getFallbackKeyword(category);
  const cacheKey = JSON.stringify({
    keyword,
    category: String(category || "All"),
    sort: String(sort || "Relevance"),
    page: requestedPage,
    pageSize: safePageSize,
    robloxOnly: !!robloxOnly
  });

  const cached = getCache(catalogCache, cacheKey);
  if (cached) {
    return cached;
  }

  const wantedCount = requestedPage * safePageSize;
  const collected = [];
  let cursor = "";
  let reachedEnd = false;
  let pages = 0;
  const maxPages = robloxOnly ? 20 : 10;

  while (collected.length < wantedCount && pages < maxPages) {
    pages += 1;

    const data = await searchCatalogPage({
      keyword,
      sort,
      limit: 30,
      cursor,
      includeOffSale: false
    });

    const rows = Array.isArray(data.data) ? data.data : [];
    let normalized = rows.map(normalizeCatalogItem);

    if (robloxOnly) {
      normalized = normalized.filter(item => item.IsRobloxCreated);
    }

    normalized = normalized.filter(item => categoryMatches(item, category));
    collected.push(...normalized);

    cursor = data.nextPageCursor || data.nextPageToken || "";

    if (!cursor || rows.length === 0) {
      reachedEnd = true;
      break;
    }
  }

  const deduped = dedupeById(collected);
  const startIndex = (requestedPage - 1) * safePageSize;
  const pageItems = deduped.slice(startIndex, startIndex + safePageSize);
  const items = await enrichLimitedPrices(pageItems);

  const result = {
    success: true,
    page: requestedPage,
    pageSize: safePageSize,
    isFinished: reachedEnd && deduped.length <= startIndex + safePageSize,
    items
  };

  setCache(catalogCache, cacheKey, result, CATALOG_CACHE_TTL_MS);
  return result;
}

async function getCatalogItemDetails(itemId) {
  const id = toPositiveInt(itemId, 0);
  if (!id) {
    throw new Error("Invalid item id");
  }

  const cached = getCache(itemCache, String(id));
  if (cached) {
    return cached;
  }

  const url = new URL(`${CATALOG_BASE_URL}/v1/catalog/items/details`);
  url.searchParams.set("itemIds", String(id));

  const data = await fetchJson(url.toString(), { timeoutMs: 9000, retries: 1 });
  const rows = Array.isArray(data.data) ? data.data : [];

  if (rows.length === 0) {
    return null;
  }

  let item = normalizeCatalogItem(rows[0]);
  item = await enrichLimitedItemPrice(item);

  const ttl = item.IsLimited ? LIMITED_PRICE_CACHE_TTL_MS : ITEM_CACHE_TTL_MS;
  setCache(itemCache, String(id), item, ttl);
  return item;
}

async function getUserGroups(userId) {
  const url = `${GROUPS_BASE_URL}/v2/users/${encodeURIComponent(userId)}/groups/roles`;
  const data = await fetchJson(url, { timeoutMs: 9000, retries: 1 });
  return Array.isArray(data.data) ? data.data : [];
}

async function getGroupThumbnails(groupIds) {
  const ids = Array.isArray(groupIds)
    ? groupIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0)
    : [];

  if (ids.length === 0) {
    return new Map();
  }

  const url = new URL(`${THUMBNAILS_BASE_URL}/v1/groups/icons`);
  url.searchParams.set("groupIds", ids.join(","));
  url.searchParams.set("size", "150x150");
  url.searchParams.set("format", "Png");
  url.searchParams.set("isCircular", "false");

  const data = await fetchJson(url.toString(), { timeoutMs: 9000, retries: 1 });
  const rows = Array.isArray(data.data) ? data.data : [];
  const out = new Map();

  for (const row of rows) {
    const id = Number(row.targetId || row.groupId || 0);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }

    out.set(id, String(row.imageUrl || "").trim());
  }

  return out;
}

function normalizePlayerGroupEntry(entry, thumbMap) {
  const group = entry?.group || {};
  const role = entry?.role || {};
  const groupId = Number(group.id || 0);

  return {
    id: groupId,
    name: String(group.name || "Group").trim() || "Group",
    description: String(group.description || "").trim(),
    memberCount: Number(group.memberCount || 0) || 0,
    roleName: String(role.name || "").trim(),
    roleRank: Number(role.rank || 0) || 0,
    thumbnail: thumbMap.get(groupId) || ""
  };
}

async function getPrimaryGroup(userId) {
  const cacheKey = `primary_group_${userId}`;
  const cached = getCache(groupCache, cacheKey);
  if (cached) {
    return cached;
  }

  const rawGroups = await getUserGroups(userId);
  const groupIds = rawGroups
    .map(entry => Number(entry?.group?.id || 0))
    .filter(id => Number.isFinite(id) && id > 0);

  const thumbMap = await getGroupThumbnails(groupIds);
  const normalized = rawGroups.map(entry => normalizePlayerGroupEntry(entry, thumbMap));

  normalized.sort((a, b) => {
    if (b.roleRank !== a.roleRank) {
      return b.roleRank - a.roleRank;
    }

    if (b.memberCount !== a.memberCount) {
      return b.memberCount - a.memberCount;
    }

    return a.name.localeCompare(b.name);
  });

  const result = normalized[0] || null;
  setCache(groupCache, cacheKey, result, GROUP_CACHE_TTL_MS);
  return result;
}

function startOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfWeekUTC() {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
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

async function getUserClassicTShirts(userId) {
  const found = [];
  const seen = new Set();

  const searches = [
    {
      label: "Classic T-Shirt",
      category: "3",
      subcategory: "55",
      assetTypeId: 2
    },
    {
      label: "Classic Shirt",
      category: "3",
      subcategory: "56",
      assetTypeId: 11
    },
    {
      label: "Classic Pants",
      category: "3",
      subcategory: "57",
      assetTypeId: 12
    }
  ];

  for (const search of searches) {
    let cursor = "";

    for (let page = 0; page < 5; page += 1) {
      const url = new URL(`${CATALOG_BASE_URL}/v1/search/items/details`);

      url.searchParams.set("CreatorType", "User");
      url.searchParams.set("CreatorTargetId", String(userId));
      url.searchParams.set("Category", search.category);
      url.searchParams.set("Subcategory", search.subcategory);
      url.searchParams.set("IncludeNotForSale", "false");
      url.searchParams.set("SalesTypeFilter", "1");
      url.searchParams.set("SortType", "3");
      url.searchParams.set("Limit", "30");

      if (cursor) {
        url.searchParams.set("Cursor", cursor);
      }

      const data = await fetchJson(url.toString(), {
        timeoutMs: 9000,
        retries: 1
      });

      const rows = Array.isArray(data.data) ? data.data : [];

      for (const rawItem of rows) {
        const assetId = Number(rawItem.id || rawItem.itemId || 0);
        const price = Number(rawItem.price ?? rawItem.lowestPrice ?? 0);

        const creatorTargetId = Number(
          rawItem.creatorTargetId ??
          rawItem.creatorId ??
          rawItem.creator?.id ??
          rawItem.creator?.creatorTargetId ??
          0
        );

        if (!Number.isFinite(assetId) || assetId <= 0) {
          continue;
        }

        if (seen.has(assetId)) {
          continue;
        }

        if (!Number.isFinite(price) || price <= 0) {
          continue;
        }

        if (creatorTargetId !== Number(userId)) {
          continue;
        }

        seen.add(assetId);

        found.push({
          AssetId: assetId,
          ItemType: "TShirt",
          ClothingType: search.label,
          Name: String(rawItem.name || rawItem.itemName || search.label),
          Price: Math.floor(price),
          Icon: `rbxthumb://type=Asset&id=${assetId}&w=420&h=420`
        });
      }

      cursor = data.nextPageCursor || data.nextPageToken || "";

      if (!cursor || rows.length === 0) {
        break;
      }
    }
  }

  found.sort((a, b) => {
    if (a.Price === b.Price) {
      return a.AssetId - b.AssetId;
    }

    return a.Price - b.Price;
  });

  return found;
}

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "Backend is running"
  });
});

app.get("/dances", (req, res) => {
  return res.json({
    Success: true,
    Items: DANCES
  });
});

app.get("/catalog/search", async (req, res) => {
  try {
    const result = await searchCatalog({
      search: req.query.search,
      category: req.query.category,
      sort: req.query.sort,
      page: req.query.page,
      pageSize: req.query.pageSize || req.query.limit,
      robloxOnly: normalizeBool(req.query.robloxOnly)
    });

    return res.json(result);
  } catch (error) {
    console.error("GET /catalog/search error:", error.stack || error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to search catalog"
    });
  }
});

app.get("/catalog/item/:id", async (req, res) => {
  try {
    const item = await getCatalogItemDetails(req.params.id);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Item not found"
      });
    }

    return res.json({
      success: true,
      item
    });
  } catch (error) {
    console.error("GET /catalog/item/:id error:", error.stack || error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch catalog item"
    });
  }
});

app.get("/player/groups", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Missing userId"
      });
    }

    const rawGroups = await getUserGroups(userId);
    const groupIds = rawGroups
      .map(entry => Number(entry?.group?.id || 0))
      .filter(id => Number.isFinite(id) && id > 0);

    const thumbMap = await getGroupThumbnails(groupIds);
    const groups = rawGroups.map(entry => normalizePlayerGroupEntry(entry, thumbMap));

    return res.json({
      success: true,
      groups
    });
  } catch (error) {
    console.error("GET /player/groups error:", error.stack || error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch player groups"
    });
  }
});

app.get("/player/primary-group", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Missing userId"
      });
    }

    const group = await getPrimaryGroup(userId);

    return res.json({
      success: true,
      group
    });
  } catch (error) {
    console.error("GET /player/primary-group error:", error.stack || error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch primary group"
    });
  }
});

app.get("/roblox-tshirts", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId || !Number.isFinite(Number(userId))) {
      return res.status(400).json({ success: false, message: "Missing userId" });
    }

    const items = await getUserClassicTShirts(userId);
    items.sort((a, b) => a.Price === b.Price ? a.AssetId - b.AssetId : a.Price - b.Price);
    return res.json({ success: true, items });
  } catch (error) {
    console.error("roblox-tshirts error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to fetch classic T-shirts" });
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
      purchaseId,
      donationMethod
    } = req.body || {};

    const donorId = Number(fromUserId);
    const receiverId = Number(toUserId);
    const donationAmount = Number(amount);
    const parsedGameId = Number(gameId || 0);
    const parsedPlaceId = Number(placeId || 0);
    const normalizedPurchaseId = String(purchaseId || "").trim();
    const normalizedDonationMethod = sanitizeString(donationMethod || "Legacy", 30) || "Legacy";

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
      donationMethod: normalizedDonationMethod,
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
        donationMethod,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      donation.donationMethod,
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
  console.log(`Catalog base URL: ${CATALOG_BASE_URL}`);
  console.log(`Economy base URL: ${ECONOMY_BASE_URL}`);
  console.log(`Groups base URL: ${GROUPS_BASE_URL}`);
  console.log(`Thumbnails base URL: ${THUMBNAILS_BASE_URL}`);
  console.log(`Dance route: /dances`);
});
