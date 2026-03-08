const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Persistent Storage ───────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || "/tmp/jean-data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filename, fallback = {}) {
  const filepath = path.join(DATA_DIR, filename);
  try { if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, "utf8")); } catch {}
  return fallback;
}
function saveJSON(filename, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2)); } catch {}
}

const conversations = {};
const watchlists    = loadJSON("watchlists.json");
const memories      = loadJSON("memories.json");
const alertUsers    = new Set(loadJSON("alerts.json", []));
const MAX_HISTORY   = 20;

function saveAll() {
  saveJSON("watchlists.json", watchlists);
  saveJSON("memories.json", memories);
  saveJSON("alerts.json", [...alertUsers]);
}

// ─── Memory helpers ───────────────────────────────────────────────────────────
function getMemory(chatId) {
  if (!memories[chatId]) memories[chatId] = { preferences: {}, cellar: [], notes: "", language: "auto" };
  return memories[chatId];
}

function buildMemoryContext(chatId) {
  const mem = getMemory(chatId);
  const parts = [];
  if (mem.notes) parts.push(`About this user: ${mem.notes}`);
  if (mem.language && mem.language !== "auto") parts.push(`Always reply in: ${mem.language}`);
  if (mem.preferences && Object.keys(mem.preferences).length > 0)
    parts.push(`Wine preferences: ${JSON.stringify(mem.preferences)}`);
  if (mem.cellar && mem.cellar.length > 0)
    parts.push(`Cellar (${mem.cellar.length} lots): ${mem.cellar.map(b => `${b.wine} ${b.vintage||""} x${b.qty}`).join(", ")}`);
  const wl = watchlists[chatId] || [];
  if (wl.length > 0)
    parts.push(`Watchlist: ${wl.map(w => `${w.wine} target ${w.currency}${w.targetPrice}`).join(", ")}`);
  return parts.length > 0 ? `\n\n[USER PROFILE]\n${parts.join("\n")}` : "";
}

function parseAndSaveMemory(chatId, text) {
  const mem = getMemory(chatId);
  const regex = /\[REMEMBER:\s*([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1].trim();
    const eqIdx = raw.indexOf("=");
    if (eqIdx === -1) continue;
    const key = raw.slice(0, eqIdx).trim().toLowerCase();
    const value = raw.slice(eqIdx + 1).trim();
    if (key === "prefers" || key === "preferences") mem.preferences.tastes = value;
    else if (key === "budget") mem.preferences.budget = value;
    else if (key === "language") mem.language = value;
    else if (key === "note") mem.notes = value;
    else if (key === "cellar_add") {
      const qtyMatch = value.match(/x(\d+)$/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
      const winePart = value.replace(/x\d+$/i, "").trim();
      const vintageMatch = winePart.match(/\b(19|20)\d{2}\b/);
      const vintage = vintageMatch ? vintageMatch[0] : null;
      const wineName = winePart.replace(/\b(19|20)\d{2}\b/, "").trim();
      mem.cellar = mem.cellar || [];
      const existing = mem.cellar.find(b => b.wine.toLowerCase() === wineName.toLowerCase() && b.vintage === vintage);
      if (existing) existing.qty += qty;
      else mem.cellar.push({ wine: wineName, vintage, qty, added: new Date().toISOString().split("T")[0] });
    } else if (key === "cellar_remove") {
      mem.cellar = (mem.cellar || []).filter(b => !b.wine.toLowerCase().includes(value.toLowerCase()));
    } else {
      mem.preferences[key] = value;
    }
  }
  saveAll();
  return text.replace(/\[REMEMBER:[^\]]+\]/g, "").trim();
}

// ─── Google Places helper ─────────────────────────────────────────────────────
async function findNearbyRestaurants(lat, lng) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=500&type=restaurant&key=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  return data.results.slice(0, 5).map(r => ({
    name: r.name,
    address: r.vicinity,
    rating: r.rating,
    priceLevel: r.price_level,
  }));
}

async function getRestaurantDetails(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,website,formatted_phone_number&key=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result || null;
}

// ─── CellarTracker CSV parser ─────────────────────────────────────────────────
function parseCellarTrackerCSV(csvText) {
  const lines = csvText.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
  const bottles = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.replace(/"/g, "").trim());
    const row = {};
    headers.forEach((h, idx) => row[h] = cols[idx] || "");
    if (row.wine || row.winename || row["wine name"]) {
      bottles.push({
        wine: row.wine || row.winename || row["wine name"] || "Unknown",
        vintage: row.vintage || row.year || null,
        qty: parseInt(row.quantity || row.qty || "1") || 1,
        location: row.location || row.bin || "",
        added: new Date().toISOString().split("T")[0],
      });
    }
  }
  return bottles;
}

// ─── System Prompt ────────────────────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are Jean Le Sommelier — the world's most authoritative personal wine agent, combining the expertise of a Master Sommelier (MS), Master of Wine (MW), and seasoned wine auction specialist.

## Global Expertise:
**Old World**: All 37 Bordeaux AOCs, every Burgundy Grand & Premier Cru, Champagne houses & growers, N&S Rhône, Loire, Alsace, Languedoc. Italy: Barolo, Barbaresco, Brunello, Amarone, all Supertuscans, Etna, all 20 regions. Spain: Rioja, Ribera del Duero, Priorat. Germany: Mosel, Rheingau, all VDP estates. Portugal: Douro, Vintage Port, Colheita. Austria, Greece, Tokaji, Georgia, Lebanon.

**New World**: All Napa AVAs, Sonoma, Oregon Pinot, Washington Syrah. Australia: Penfolds, Henschke, Barossa, Margaret River. NZ: Marlborough, Central Otago. South America: Mendoza Malbec, Chilean Carménère. South Africa: Stellenbosch, Swartland.

**Auction & Investment**: Sotheby's, Christie's, Hart Davis Hart, Zachys, Acker Merrall, Bonhams, iDealwine, Liv-ex indices. Market cycles, seasonal patterns, en primeur, provenance. Cult wines: Screaming Eagle, Harlan, Petrus, DRC, Leroy, Giacomo Conterno, Soldera.

**Additional**: Vintage charts 50+ years, Michelin-level pairing, cellar management, drinking windows, natural/biodynamic wines.

## Behaviour:
- Confident, precise, warm, personal
- Use web search for current prices, auction results, recent news
- Always reply in the user's language automatically
- When analyzing photos: identify wine precisely, give market value, quality assessment, recommendation
- When user shares location: acknowledge and offer to help find wine-friendly restaurants nearby

## Memory Instructions:
Extract and store personal info using tags at END of response:
[REMEMBER: prefers=Burgundy Pinot Noir]
[REMEMBER: budget=under $300]
[REMEMBER: cellar_add=Sassicaia 2019 x2]
[REMEMBER: language=French]
[REMEMBER: note=Expert collector, 20 years experience]
Only add when genuinely new info is shared.

## Formatting for Telegram:
- *bold* for key terms and verdicts
- Short paragraphs, scannable
- Auction verdicts: *BUY / PASS / WATCH*
- Restaurant picks: *Top Pick* and *Runner-Up*
- Emojis sparingly`;

function getSystemPrompt(chatId) {
  return BASE_SYSTEM_PROMPT + buildMemoryContext(chatId);
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function getReply(chatId, userMessage) {
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: userMessage });
  if (conversations[chatId].length > MAX_HISTORY)
    conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: getSystemPrompt(chatId),
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: conversations[chatId],
  });

  const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("") || "Please try again.";
  const cleanText = parseAndSaveMemory(chatId, rawText);
  conversations[chatId].push({ role: "assistant", content: cleanText });
  return cleanText;
}

async function getReplyWithImage(chatId, base64Image, caption) {
  if (!conversations[chatId]) conversations[chatId] = [];
  const userContent = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
    { type: "text", text: caption || "Please analyze this wine image in detail." },
  ];
  conversations[chatId].push({ role: "user", content: userContent });
  if (conversations[chatId].length > MAX_HISTORY)
    conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: getSystemPrompt(chatId),
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: conversations[chatId],
  });

  const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("") || "Please try again.";
  const cleanText = parseAndSaveMemory(chatId, rawText);
  conversations[chatId].pop();
  conversations[chatId].push({ role: "user", content: `[User sent wine photo${caption ? `: "${caption}"` : ""}]` });
  conversations[chatId].push({ role: "assistant", content: cleanText });
  return cleanText;
}

// ─── Send helper ──────────────────────────────────────────────────────────────
async function sendReply(chatId, text) {
  if (!text || !text.trim()) return;
  const chunks = text.match(/.{1,4000}/gs) || [text];
  for (const chunk of chunks) {
    try { await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }); }
    catch { await bot.sendMessage(chatId, chunk); }
  }
}

// ─── Watchlist helpers ────────────────────────────────────────────────────────
function addToWatchlist(chatId, wine, region, targetPrice, currency = "USD") {
  if (!watchlists[chatId]) watchlists[chatId] = [];
  watchlists[chatId].push({
    wine, region: region || "Unknown",
    targetPrice: parseFloat(targetPrice) || 0,
    currency: (currency || "USD").toUpperCase(),
    addedAt: new Date().toISOString().split("T")[0],
  });
  saveAll();
}

// ─── Daily alert 9am ─────────────────────────────────────────────────────────
cron.schedule("0 9 * * *", async () => {
  for (const chatId of alertUsers) {
    const wl = watchlists[chatId] || [];
    const mem = getMemory(chatId);
    try {
      const wlText = wl.length > 0
        ? wl.map((w, i) => `${i+1}. ${w.wine} — Target: ${w.currency} ${w.targetPrice}`).join("\n")
        : "No specific watchlist — give a general market briefing.";
      const prompt = `Search for recent auction results and price movements. Write a morning update (max 200 words).\n\nWatchlist:\n${wlText}\n\nProfile: ${mem.notes || "Wine enthusiast"}\n\nCover: notable recent sales, watched wines near/below target, upcoming auctions. Use real prices if found. Sign off as Jean.`;
      const response = await anthropic.messages.create({
        model: "claude-opus-4-5", max_tokens: 512,
        system: getSystemPrompt(chatId),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      });
      const text = parseAndSaveMemory(chatId, response.content.filter(b => b.type === "text").map(b => b.text).join("") || "Markets quiet today. 🍷");
      await sendReply(chatId, `🌅 *Morning Market Update*\n\n${text}`);
    } catch (err) { console.error(`Alert error ${chatId}:`, err.message); }
  }
});

// ─── Weekly digest Sunday 10am ────────────────────────────────────────────────
cron.schedule("0 10 * * 0", async () => {
  for (const chatId of alertUsers) {
    const wl = watchlists[chatId] || [];
    const mem = getMemory(chatId);
    try {
      const cellarText = mem.cellar?.length > 0
        ? mem.cellar.map(b => `${b.wine} ${b.vintage||""} x${b.qty}`).join(", ")
        : "Not specified";
      const prompt = `Write a weekly wine digest (max 300 words). Search for this week's notable auction results, en primeur news, or new critic scores.\n\nWatchlist: ${wl.map(w=>w.wine).join(", ")||"None"}\nCellar: ${cellarText}\nProfile: ${mem.notes||"Wine enthusiast"}\n\nStructure:\n1. *This Week in Wine* — 2-3 highlights\n2. *Your Watchlist* — any movements?\n3. *Cellar Alert* — wines approaching peak window?\n4. *Jean's Pick of the Week* — one wine to discover\n\nSign off as Jean.`;
      const response = await anthropic.messages.create({
        model: "claude-opus-4-5", max_tokens: 600,
        system: getSystemPrompt(chatId),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      });
      const text = parseAndSaveMemory(chatId, response.content.filter(b => b.type === "text").map(b => b.text).join(""));
      await sendReply(chatId, `📰 *Weekly Wine Digest*\n\n${text}`);
    } catch (err) { console.error(`Digest error ${chatId}:`, err.message); }
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  const name = msg.from.first_name || "there";
  sendReply(chatId, `🍷 *Bonjour, ${name}. I'm Jean Le Sommelier.*\n\nYour personal wine agent — Master Sommelier, auction analyst, and global market advisor.\n\n*What I can do:*\n• 📸 Identify any wine from a photo\n• 🎙 Understand voice messages\n• 🧠 Remember your preferences & cellar permanently\n• 📍 Find wine-friendly restaurants near you\n• 📋 Import your CellarTracker cellar (send the CSV)\n• Recommend the perfect bottle from any wine list\n• BUY / PASS / WATCH on any auction lot\n• Daily morning alerts & weekly Sunday digest\n• Reply in your language automatically\n\n*Commands:*\n/memory — What I know about you\n/cellar — Your cellar\n/watchlist — Tracked wines\n/add — Track a wine\n/alerts — Toggle alerts\n/forget — Clear my memory\n/help — All commands\n\nTell me about your wine preferences and I'll start learning. 🍾`);
});

bot.onText(/\/memory/, (msg) => {
  const chatId = msg.chat.id;
  const mem = getMemory(chatId);
  const parts = [];
  if (mem.notes) parts.push(`*Profile:* ${mem.notes}`);
  if (mem.language && mem.language !== "auto") parts.push(`*Language:* ${mem.language}`);
  if (mem.preferences && Object.keys(mem.preferences).length > 0)
    Object.entries(mem.preferences).forEach(([k,v]) => parts.push(`*${k}:* ${v}`));
  const wl = watchlists[chatId] || [];
  if (wl.length > 0) parts.push(`*Watchlist:* ${wl.length} wine(s)`);
  if (mem.cellar?.length > 0) parts.push(`*Cellar:* ${mem.cellar.length} lot(s)`);
  if (parts.length === 0)
    sendReply(chatId, "I don't know much about you yet! Just chat — tell me what wines you love, your budget, your regions. I'll remember automatically.");
  else
    sendReply(chatId, `🧠 *What I know about you:*\n\n${parts.join("\n")}\n\n_Use /forget to reset._`);
});

bot.onText(/\/cellar/, (msg) => {
  const chatId = msg.chat.id;
  const cellar = getMemory(chatId).cellar || [];
  if (cellar.length === 0) {
    sendReply(chatId, "Your cellar is empty.\n\n*Two ways to add bottles:*\n• Tell me naturally: _\"Add Sassicaia 2019 x3 to my cellar\"_\n• Send your CellarTracker CSV export and I'll import everything automatically");
    return;
  }
  const list = cellar.map((b,i) => `${i+1}. *${b.wine}* ${b.vintage||""} — ${b.qty} bottle(s)${b.location ? ` (${b.location})` : ""}`).join("\n");
  sendReply(chatId, `🍾 *Your Cellar* (${cellar.length} lots)\n\n${list}\n\nAsk me about drinking windows, or say \"remove [wine name] from cellar\" to delete.`);
});

bot.onText(/\/watchlist/, (msg) => {
  const chatId = msg.chat.id;
  const wl = watchlists[chatId] || [];
  if (wl.length === 0) {
    sendReply(chatId, "Your watchlist is empty.\n\n`/add Château Pétrus 2015, Pomerol, 3500, USD`");
    return;
  }
  const list = wl.map((w,i) => `${i+1}. *${w.wine}*\n   ${w.region} — Target: ${w.currency} ${w.targetPrice.toLocaleString()}`).join("\n\n");
  sendReply(chatId, `🍷 *Watchlist* (${wl.length} wine${wl.length!==1?"s":""})\n\n${list}\n\nRemove: /remove 1`);
});

bot.onText(/\/add (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].split(",").map(s => s.trim());
  if (parts.length < 2) {
    sendReply(chatId, "Format: `/add Wine Name, Region, TargetPrice, Currency`\n\nExample:\n`/add Château Pétrus 2015, Pomerol, 3500, USD`");
    return;
  }
  const [wine, region, price, currency] = parts;
  addToWatchlist(chatId, wine, region, price, currency);
  sendReply(chatId, `✅ *${wine}* added to watchlist.\n\nEnable /alerts for daily price updates.`);
});

bot.onText(/\/remove (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const wl = watchlists[chatId] || [];
  const idx = parseInt(match[1]) - 1;
  if (wl[idx]) {
    const removed = wl.splice(idx, 1)[0];
    saveAll();
    sendReply(chatId, `🗑 Removed *${removed.wine}* from watchlist.`);
  } else {
    sendReply(chatId, "Wine not found. Use /watchlist to see your list.");
  }
});

bot.onText(/\/alerts/, (msg) => {
  const chatId = msg.chat.id;
  if (alertUsers.has(chatId)) {
    alertUsers.delete(chatId); saveAll();
    sendReply(chatId, "🔕 Alerts *disabled*. Send /alerts to re-enable.");
  } else {
    alertUsers.add(chatId); saveAll();
    const wl = watchlists[chatId] || [];
    sendReply(chatId, `🔔 Alerts *enabled!*\n\n• 🌅 Daily market update at 9am\n• 📰 Weekly digest every Sunday 10am${wl.length===0?"\n\n_Tip: Use /add to track wines for personalised alerts._":`\n\nMonitoring your ${wl.length} watched wine(s).`}`);
  }
});

bot.onText(/\/forget/, (msg) => {
  const chatId = msg.chat.id;
  memories[chatId] = { preferences: {}, cellar: [], notes: "", language: "auto" };
  conversations[chatId] = [];
  saveAll();
  sendReply(chatId, "🧹 Memory cleared. Fresh start — what shall I call you?");
});

bot.onText(/\/clear/, (msg) => {
  conversations[msg.chat.id] = [];
  sendReply(msg.chat.id, "Conversation reset. Your memory and watchlist are still saved. 🍷");
});

bot.onText(/\/help/, (msg) => {
  sendReply(msg.chat.id, `*Jean Le Sommelier — Commands*\n\n/start — Welcome\n/memory — What I know about you\n/cellar — Your cellar inventory\n/watchlist — Tracked wines\n/add [wine, region, price, currency] — Track a wine\n/remove [number] — Remove from watchlist\n/alerts — Toggle daily & weekly alerts\n/forget — Clear all memory\n/clear — Reset conversation only\n/help — This message\n\n*Just talk naturally for everything else.*\nSend 📸 photos, 🎙 voice notes, 📍 your location, or a CellarTracker CSV — I handle it all.`);
});

// ─── Photo handler ────────────────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
    const imageRes = await fetch(fileUrl);
    const base64Image = Buffer.from(await imageRes.arrayBuffer()).toString("base64");
    const reply = await getReplyWithImage(chatId, base64Image, msg.caption || "");
    await sendReply(chatId, reply);
  } catch (err) {
    console.error("Photo error:", err);
    sendReply(chatId, "I had trouble reading that image — please try again. 🙏");
  }
});

// ─── Document handler (CellarTracker CSV import) ─────────────────────────────
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;
  const isCSV = doc.mime_type === "text/csv" || doc.file_name?.endsWith(".csv");
  if (!isCSV) {
    sendReply(chatId, "I can import CellarTracker CSV files. Export your cellar from CellarTracker (Account → Export Data) and send me the CSV file.");
    return;
  }
  bot.sendChatAction(chatId, "typing");
  try {
    const file = await bot.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
    const res = await fetch(fileUrl);
    const csvText = await res.text();
    const bottles = parseCellarTrackerCSV(csvText);
    if (bottles.length === 0) {
      sendReply(chatId, "I couldn't read that CSV. Make sure it's a CellarTracker export. Try: Account Settings → Export Data → Download CSV.");
      return;
    }
    const mem = getMemory(chatId);
    mem.cellar = bottles;
    saveAll();
    const preview = bottles.slice(0, 5).map(b => `• ${b.wine} ${b.vintage||""} x${b.qty}`).join("\n");
    const more = bottles.length > 5 ? `\n_...and ${bottles.length - 5} more_` : "";
    sendReply(chatId, `✅ *Cellar imported successfully!*\n\n*${bottles.length} lots loaded:*\n${preview}${more}\n\nAsk me about drinking windows, what to open tonight, or which bottles to sell. 🍾`);
  } catch (err) {
    console.error("CSV error:", err);
    sendReply(chatId, "I had trouble importing that file. Please try again.");
  }
});

// ─── Location handler (Google Places) ────────────────────────────────────────
bot.on("location", async (msg) => {
  const chatId = msg.chat.id;
  const { latitude, longitude } = msg.location;
  bot.sendChatAction(chatId, "typing");

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    const reply = await getReply(chatId, `The user is at coordinates ${latitude}, ${longitude}. Acknowledge their location and offer wine-related help — recommend what to look for in restaurants nearby, or ask what they need help with.`);
    await sendReply(chatId, reply);
    return;
  }

  try {
    const restaurants = await findNearbyRestaurants(latitude, longitude);
    if (!restaurants || restaurants.length === 0) {
      sendReply(chatId, "I couldn't find restaurants near you right now. Tell me what you're looking for and I'll help! 🍷");
      return;
    }
    const restList = restaurants.map((r, i) =>
      `${i+1}. *${r.name}* — ${r.address} ⭐ ${r.rating || "?"}`
    ).join("\n");
    const reply = await getReply(chatId,
      `The user shared their location. Nearby restaurants:\n${restList}\n\nAcknowledge their location warmly, show this list, and offer to help them pick the best wine at whichever restaurant they choose. Ask which one they're heading to or if they need help choosing.`
    );
    await sendReply(chatId, reply);
  } catch (err) {
    console.error("Location error:", err);
    sendReply(chatId, "I had trouble finding nearby restaurants. Tell me where you are and I'll help! 🍷");
  }
});

// ─── Voice handler ────────────────────────────────────────────────────────────
bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  try {
    const file = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

    if (process.env.OPENAI_API_KEY) {
      const FormData = require("form-data");
      const audioRes = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
      const form = new FormData();
      form.append("file", audioBuffer, { filename: "voice.ogg", contentType: "audio/ogg" });
      form.append("model", "whisper-1");
      const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
        body: form,
      });
      const whisperData = await whisperRes.json();
      if (whisperData.text) {
        await sendReply(chatId, `🎙 _I heard: "${whisperData.text}"_`);
        const reply = await getReply(chatId, whisperData.text);
        await sendReply(chatId, reply);
      } else {
        sendReply(chatId, "I couldn't transcribe that voice note. Please try again or type your question.");
      }
    } else {
      sendReply(chatId, "🎙 I received your voice message!\n\nTo enable full voice transcription, add an `OPENAI_API_KEY` to your Railway variables (free at platform.openai.com).\n\nFor now, please type your question and I'll answer right away.");
    }
  } catch (err) {
    console.error("Voice error:", err);
    sendReply(chatId, "I had trouble with that voice note — please type instead. 🙏");
  }
});

// ─── Text handler ─────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;
  bot.sendChatAction(chatId, "typing");
  try {
    const reply = await getReply(chatId, text);
    await sendReply(chatId, reply);
  } catch (err) {
    console.error("Message error:", err);
    sendReply(chatId, "I had a brief issue — please try again. 🙏");
  }
});

// ─── Internal HTTP server (receives alerts from Monitor Agent) ────────────────
const http = require("http");
const MONITOR_SECRET = process.env.MONITOR_SECRET || "jean-monitor-secret";
const INTERNAL_PORT = process.env.INTERNAL_PORT || 3001;

async function formatMonitorAlert(chatId, alertData) {
  const { alerts, userProfile } = alertData;
  const parts = [];

  for (const alert of alerts) {
    if (alert.type === "watchlist" && alert.data) {
      const d = alert.data;
      let emoji = d.recommendation === "BUY" ? "🟢" : d.recommendation === "WATCH" ? "🟡" : "🔴";
      parts.push(`${emoji} *${alert.wine}*\n*${d.recommendation}* — ${d.currentMarketPrice}\nTarget: ${d.targetPrice}\n${d.summary}`);
      if (d.activeAuctions?.length > 0)
        parts.push(`_Active lots: ${d.activeAuctions.slice(0,2).join(" | ")}_`);
    }
    if (alert.type === "news" && alert.data?.newsItems?.length > 0) {
      const items = alert.data.newsItems.map(n => `• *${n.headline}*\n  ${n.detail}`).join("\n");
      parts.push(`📰 *Market News*\n${items}`);
    }
    if (alert.type === "calendar" && alert.data?.upcomingAuctions?.length > 0) {
      const auctions = alert.data.upcomingAuctions.slice(0,3)
        .map(a => `• *${a.house}* — ${a.saleName} (${a.date}, ${a.location})`).join("\n");
      parts.push(`🔨 *Upcoming Auctions*\n${auctions}`);
    }
  }

  if (parts.length === 0) return null;

  // Ask Jean to format it beautifully
  const rawData = parts.join("\n\n");
  const formatPrompt = `The background monitor agent found these alerts for the user. Format them as a concise, elegant Telegram message — warm but direct. Use *bold* for key terms. Max 300 words. Sign off as Jean.\n\nRaw data:\n${rawData}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 512,
      system: getSystemPrompt(chatId),
      messages: [{ role: "user", content: formatPrompt }],
    });
    return response.content.filter(b => b.type === "text").map(b => b.text).join("");
  } catch {
    return `🔔 *Market Alert*\n\n${rawData}`;
  }
}

const internalServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/internal/alert") {
    // Verify secret
    const secret = req.headers["x-monitor-secret"];
    if (secret !== MONITOR_SECRET) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { chatId, alertData } = JSON.parse(body);
        console.log(`[Jean] Received monitor alert for chat ${chatId}`);

        const message = await formatMonitorAlert(chatId, alertData);
        if (message) {
          await sendReply(chatId, `🔔 *Alert from your Wine Monitor*\n\n${message}`);
          console.log(`[Jean] Alert sent to user ${chatId}`);
        }

        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        console.error("[Jean] Alert processing error:", err);
        res.writeHead(500);
        res.end("Error");
      }
    });
  } else if (req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", service: "jean-le-sommelier", time: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

internalServer.listen(INTERNAL_PORT, () => {
  console.log(`[Jean] Internal server listening on port ${INTERNAL_PORT}`);
});

console.log("🍷 Jean Le Sommelier v5 — memory, photos, voice, location, CSV import, monitor integration.");
