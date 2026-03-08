const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Persistent Storage (JSON files survive Railway restarts) ─────────────────
const DATA_DIR = process.env.DATA_DIR || "/tmp/jean-data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filename, fallback = {}) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {}
  return fallback;
}

function saveJSON(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  try { fs.writeFileSync(filepath, JSON.stringify(data, null, 2)); } catch {}
}

// ─── In-memory state (with persistence) ──────────────────────────────────────
const conversations = {};                          // not persisted (too large)
const watchlists    = loadJSON("watchlists.json"); // { chatId: [...] }
const memories      = loadJSON("memories.json");   // { chatId: { preferences, cellar, notes } }
const alertUsers    = new Set(loadJSON("alerts.json", []));
const MAX_HISTORY   = 20;

function saveAll() {
  saveJSON("watchlists.json", watchlists);
  saveJSON("memories.json", memories);
  saveJSON("alerts.json", [...alertUsers]);
}

// ─── Memory helpers ───────────────────────────────────────────────────────────
function getMemory(chatId) {
  if (!memories[chatId]) {
    memories[chatId] = { preferences: {}, cellar: [], notes: "", language: "auto" };
  }
  return memories[chatId];
}

function buildMemoryContext(chatId) {
  const mem = getMemory(chatId);
  const parts = [];
  if (mem.notes) parts.push(`About this user: ${mem.notes}`);
  if (mem.language && mem.language !== "auto") parts.push(`User's preferred language: ${mem.language}. Always reply in this language.`);
  if (mem.preferences && Object.keys(mem.preferences).length > 0) {
    parts.push(`User's wine preferences: ${JSON.stringify(mem.preferences)}`);
  }
  if (mem.cellar && mem.cellar.length > 0) {
    parts.push(`User's cellar (${mem.cellar.length} bottles): ${mem.cellar.map(b => `${b.wine} x${b.qty} (${b.vintage || "NV"})`).join(", ")}`);
  }
  const wl = watchlists[chatId] || [];
  if (wl.length > 0) {
    parts.push(`User's watchlist: ${wl.map(w => `${w.wine} target ${w.currency}${w.targetPrice}`).join(", ")}`);
  }
  return parts.length > 0 ? `\n\n[USER PROFILE]\n${parts.join("\n")}` : "";
}

// ─── System Prompt ────────────────────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are Jean Le Sommelier — the world's most authoritative personal wine agent, combining the expertise of a Master Sommelier (MS), Master of Wine (MW), and seasoned wine auction specialist.

## Your Global Expertise:

**Old World**
- France: All 37 AOCs of Bordeaux (Left & Right Bank), every Premier & Grand Cru of Burgundy, Champagne houses & growers, Northern & Southern Rhône, Loire, Alsace, Languedoc
- Italy: Barolo, Barbaresco, Brunello, Amarone, Sassicaia, Ornellaia, all Supertuscans, Chianti Classico, Etna, all 20 regions
- Spain: Rioja, Ribera del Duero, Priorat, Albariño, Jerez, Cava
- Germany: Mosel Riesling, Rheingau, all Prädikat levels, VDP estates
- Portugal: Douro, Dão, Alentejo, Vinho Verde, Vintage Port, Colheita
- Austria, Greece, Hungary (Tokaji), Georgia (Qvevri), Lebanon (Château Musar)

**New World**
- USA: All Napa AVAs, Sonoma, Oregon Pinot, Washington Syrah, Central Coast
- Australia: Penfolds full lineup, Henschke, Barossa, Clare Valley, Margaret River, Yarra Valley
- New Zealand: Marlborough, Central Otago, Hawke's Bay
- South America: Mendoza Malbec, Chilean Carménère, Uruguayan Tannat
- South Africa: Stellenbosch, Swartland, Eben Sadie, Boekenhoutskloof

**Auction & Investment Markets**
- Deep knowledge of Sotheby's, Christie's, Hart Davis Hart, Zachys, Acker Merrall, Bonhams, iDealwine
- Market cycles, seasonal auction patterns (NY/London/HK spring & autumn)
- Investment-grade wines, en primeur, provenance, storage conditions impact on value
- Cult wines: Screaming Eagle, Harlan, Petrus, DRC, Leroy, Giacomo Conterno, Soldera, Sine Qua Non

**Additional**
- Vintage charts for every major region going back 50 years
- Michelin-level food & wine pairing
- Cellar management, drinking windows, aging potential
- Natural, biodynamic, and organic wine movements

## Behaviour:
- Confident and precise — never hedge unnecessarily
- Warm and personal — remember the user's preferences and history
- Proactive — if someone mentions a dinner, ask for the menu
- Global perspective — naturally reference comparable wines across regions
- Use web search for current prices, recent auction results, or breaking news
- **Language**: Always respond in the same language the user writes in. If they write in French, respond in French. Spanish → Spanish. Etc.

## Memory Instructions:
When the user shares personal information (taste preferences, budget, cellar contents, dietary needs, location, etc.), extract it and store it by including a special tag at the END of your response:
[REMEMBER: key=value]
Examples:
[REMEMBER: prefers=Burgundy Pinot Noir and aged Barolo]
[REMEMBER: budget=under $300 per bottle]
[REMEMBER: cellar_add=Sassicaia 2019 x2]
[REMEMBER: language=French]
[REMEMBER: note=Expert collector, been drinking fine wine for 20 years]
Only add [REMEMBER:] tags when genuinely new information is shared. Never fabricate or repeat what you already know.

## Photo Analysis:
When shown a photo of a wine bottle, label, wine list, or auction catalog:
- Identify the wine precisely (producer, appellation, vintage if visible)
- Give current market value (search if needed)
- Assess quality and value
- Give a clear recommendation

## Formatting for Telegram:
- Use *bold* sparingly for key terms and verdicts
- Short paragraphs, scannable
- For auction verdicts: lead with *BUY / PASS / WATCH*
- For restaurant picks: give *Top Pick* and *Runner-Up*
- Emojis very sparingly`;

function getSystemPrompt(chatId) {
  return BASE_SYSTEM_PROMPT + buildMemoryContext(chatId);
}

// ─── Parse and save [REMEMBER:] tags from Claude's response ──────────────────
function parseAndSaveMemory(chatId, text) {
  const mem = getMemory(chatId);
  const regex = /\[REMEMBER:\s*([^\]]+)\]/g;
  let match;
  let cleanText = text;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[1].trim();
    const eqIdx = raw.indexOf("=");
    if (eqIdx === -1) continue;
    const key = raw.slice(0, eqIdx).trim().toLowerCase();
    const value = raw.slice(eqIdx + 1).trim();

    if (key === "prefers" || key === "preferences") {
      mem.preferences.tastes = value;
    } else if (key === "budget") {
      mem.preferences.budget = value;
    } else if (key === "language") {
      mem.language = value;
    } else if (key === "note") {
      mem.notes = value;
    } else if (key === "cellar_add") {
      // parse "Wine Name YYYY xN"
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

  // Strip [REMEMBER:...] tags from visible text
  cleanText = text.replace(/\[REMEMBER:[^\]]+\]/g, "").trim();
  saveAll();
  return cleanText;
}

// ─── Claude API call ──────────────────────────────────────────────────────────
async function getReply(chatId, userMessage) {
  if (!conversations[chatId]) conversations[chatId] = [];

  conversations[chatId].push({ role: "user", content: userMessage });
  if (conversations[chatId].length > MAX_HISTORY) {
    conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
  }

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

// ─── Claude API call with image ───────────────────────────────────────────────
async function getReplyWithImage(chatId, base64Image, caption) {
  if (!conversations[chatId]) conversations[chatId] = [];

  const userContent = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
    { type: "text", text: caption || "Please analyze this wine image in detail." },
  ];

  conversations[chatId].push({ role: "user", content: userContent });
  if (conversations[chatId].length > MAX_HISTORY) {
    conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
  }

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: getSystemPrompt(chatId),
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: conversations[chatId],
  });

  const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("") || "Please try again.";
  const cleanText = parseAndSaveMemory(chatId, rawText);

  // Replace image message with text summary in history (images are too large to keep)
  conversations[chatId].pop();
  conversations[chatId].push({
    role: "user",
    content: `[User sent a wine photo${caption ? `: "${caption}"` : ""}]`,
  });
  conversations[chatId].push({ role: "assistant", content: cleanText });
  return cleanText;
}

// ─── Voice message handler ────────────────────────────────────────────────────
async function transcribeVoice(fileUrl) {
  const response = await fetch(fileUrl);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Use Claude to acknowledge voice — Anthropic doesn't have a direct STT API
  // so we inform the user gracefully and suggest workaround
  return null; // handled below
}

// ─── Send helper ──────────────────────────────────────────────────────────────
async function sendReply(chatId, text) {
  if (!text || text.trim() === "") return;
  const chunks = text.match(/.{1,4000}/gs) || [text];
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    } catch {
      await bot.sendMessage(chatId, chunk); // fallback without markdown
    }
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

function removeFromWatchlist(chatId, index) {
  if (watchlists[chatId]?.[index] !== undefined) {
    const removed = watchlists[chatId].splice(index, 1)[0];
    saveAll();
    return removed;
  }
  return null;
}

// ─── Daily alert (9am) ────────────────────────────────────────────────────────
cron.schedule("0 9 * * *", async () => {
  console.log(`[${new Date().toISOString()}] Daily alert check for ${alertUsers.size} users`);
  for (const chatId of alertUsers) {
    const wl = watchlists[chatId] || [];
    const mem = getMemory(chatId);
    try {
      const wlText = wl.length > 0
        ? wl.map((w, i) => `${i + 1}. ${w.wine} — Target: ${w.currency} ${w.targetPrice}`).join("\n")
        : "No specific watchlist — give a general market briefing.";

      const alertPrompt = `Search for recent auction results and price movements. Then write a morning market update (max 200 words) for this user.\n\nWatchlist:\n${wlText}\n\nUser profile: ${mem.notes || "Wine enthusiast"}\n\nCover: notable recent sales, whether any watched wines are near/below target, upcoming auctions worth noting. Be specific with real prices if found. Sign off as Jean.`;

      const response = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 512,
        system: getSystemPrompt(chatId),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: alertPrompt }],
      });

      const alertText = response.content.filter(b => b.type === "text").map(b => b.text).join("") ||
        "Markets quiet today. No major movements on your watchlist. A good day for patience. 🍷";

      const cleanAlert = parseAndSaveMemory(chatId, alertText);
      await sendReply(chatId, `🌅 *Morning Market Update*\n\n${cleanAlert}`);
    } catch (err) {
      console.error(`Alert error ${chatId}:`, err.message);
    }
  }
});

// ─── Weekly digest (Sunday 10am) ─────────────────────────────────────────────
cron.schedule("0 10 * * 0", async () => {
  console.log(`[${new Date().toISOString()}] Weekly digest for ${alertUsers.size} users`);
  for (const chatId of alertUsers) {
    const wl = watchlists[chatId] || [];
    const mem = getMemory(chatId);
    try {
      const cellarText = mem.cellar && mem.cellar.length > 0
        ? mem.cellar.map(b => `${b.wine} ${b.vintage || ""} x${b.qty}`).join(", ")
        : "Not specified";

      const digestPrompt = `Write a weekly wine market digest (max 300 words) for this user. Search for this week's notable auction results, en primeur news, or critic scores released.\n\nWatchlist: ${wl.map(w => w.wine).join(", ") || "None"}\nCellar: ${cellarText}\nProfile: ${mem.notes || "Wine enthusiast"}\n\nStructure:\n1. *This Week in Wine* — 2-3 market highlights\n2. *Your Watchlist* — any movements?\n3. *Cellar Alert* — any wines approaching peak drinking window?\n4. *Jean's Pick of the Week* — one wine to discover\n\nSign off as Jean.`;

      const response = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 600,
        system: getSystemPrompt(chatId),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: digestPrompt }],
      });

      const digestText = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      const cleanDigest = parseAndSaveMemory(chatId, digestText);
      await sendReply(chatId, `📰 *Weekly Wine Digest*\n\n${cleanDigest}`);
    } catch (err) {
      console.error(`Digest error ${chatId}:`, err.message);
    }
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "there";
  conversations[chatId] = [];
  sendReply(chatId,
    `🍷 *Bonjour, ${name}. I'm Jean Le Sommelier.*\n\nYour personal wine agent — Master Sommelier, auction analyst, and global market advisor.\n\n*What I can do:*\n• 📸 Identify any wine from a photo instantly\n• 🎙 Analyze voice messages\n• 🧠 Remember your preferences, cellar & taste profile permanently\n• Recommend the perfect bottle from any wine list\n• BUY / PASS / WATCH on any auction lot with live price search\n• Track your watchlist with daily morning alerts\n• Manage your cellar & drinking windows\n• 📰 Weekly market digest every Sunday\n• Reply in your language automatically\n\n*Commands:*\n/memory — View what I know about you\n/cellar — Your cellar inventory\n/watchlist — Your tracked wines\n/add — Track a wine\n/alerts — Toggle daily alerts & weekly digest\n/forget — Clear my memory of you\n/help — All commands\n\nTell me about your taste in wine and I'll start learning. Or just ask me anything. 🍾`
  );
});

bot.onText(/\/memory/, (msg) => {
  const chatId = msg.chat.id;
  const mem = getMemory(chatId);
  const parts = [];
  if (mem.notes) parts.push(`*Profile:* ${mem.notes}`);
  if (mem.language && mem.language !== "auto") parts.push(`*Language:* ${mem.language}`);
  if (mem.preferences && Object.keys(mem.preferences).length > 0) {
    Object.entries(mem.preferences).forEach(([k, v]) => parts.push(`*${k}:* ${v}`));
  }
  const wl = watchlists[chatId] || [];
  if (wl.length > 0) parts.push(`*Watchlist:* ${wl.length} wine(s)`);
  if (mem.cellar && mem.cellar.length > 0) parts.push(`*Cellar:* ${mem.cellar.length} bottle(s)`);

  if (parts.length === 0) {
    sendReply(chatId, "I don't know much about you yet! Just chat with me — tell me what wines you love, your budget, regions you're into. I'll remember everything automatically.");
  } else {
    sendReply(chatId, `🧠 *What I know about you:*\n\n${parts.join("\n")}\n\n_This is saved permanently. Use /forget to reset._`);
  }
});

bot.onText(/\/cellar/, (msg) => {
  const chatId = msg.chat.id;
  const mem = getMemory(chatId);
  const cellar = mem.cellar || [];
  if (cellar.length === 0) {
    sendReply(chatId, "Your cellar is empty.\n\nJust tell me: _\"Add Sassicaia 2019 x3 to my cellar\"_ and I'll track it automatically.");
    return;
  }
  const list = cellar.map((b, i) =>
    `${i + 1}. *${b.wine}* ${b.vintage || ""} — ${b.qty} bottle(s)`
  ).join("\n");
  sendReply(chatId, `🍾 *Your Cellar* (${cellar.length} lots)\n\n${list}\n\nAsk me about drinking windows or add/remove bottles naturally.`);
});

bot.onText(/\/watchlist/, (msg) => {
  const chatId = msg.chat.id;
  const wl = watchlists[chatId] || [];
  if (wl.length === 0) {
    sendReply(chatId, "Your watchlist is empty.\n\n`/add Château Pétrus 2015, Pomerol, 3500, USD`");
    return;
  }
  const list = wl.map((w, i) =>
    `${i + 1}. *${w.wine}*\n   ${w.region} — Target: ${w.currency} ${w.targetPrice.toLocaleString()}`
  ).join("\n\n");
  sendReply(chatId, `🍷 *Watchlist* (${wl.length} wine${wl.length !== 1 ? "s" : ""})\n\n${list}\n\nRemove: /remove 1`);
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
  const removed = removeFromWatchlist(chatId, parseInt(match[1]) - 1);
  if (removed) sendReply(chatId, `🗑 Removed *${removed.wine}* from watchlist.`);
  else sendReply(chatId, "Wine not found. Use /watchlist to see your list.");
});

bot.onText(/\/alerts/, (msg) => {
  const chatId = msg.chat.id;
  if (alertUsers.has(chatId)) {
    alertUsers.delete(chatId);
    saveAll();
    sendReply(chatId, "🔕 Alerts *disabled*. Daily morning updates and weekly digest are off.\n\nSend /alerts to re-enable.");
  } else {
    alertUsers.add(chatId);
    saveAll();
    const wl = watchlists[chatId] || [];
    sendReply(chatId,
      `🔔 Alerts *enabled!*\n\n• 🌅 Daily market update at 9am\n• 📰 Weekly digest every Sunday 10am${wl.length === 0 ? "\n\n_Tip: Use /add to track wines for personalised alerts._" : `\n\nMonitoring your ${wl.length} watched wine(s).`}`
    );
  }
});

bot.onText(/\/forget/, (msg) => {
  const chatId = msg.chat.id;
  memories[chatId] = { preferences: {}, cellar: [], notes: "", language: "auto" };
  conversations[chatId] = [];
  saveAll();
  sendReply(chatId, "🧹 Memory cleared. I've forgotten everything about you and we're starting fresh. What shall I call you?");
});

bot.onText(/\/clear/, (msg) => {
  conversations[msg.chat.id] = [];
  sendReply(msg.chat.id, "Conversation reset. Your memory and watchlist are still saved. 🍷");
});

bot.onText(/\/help/, (msg) => {
  sendReply(msg.chat.id,
    `*Jean Le Sommelier — Commands*\n\n/start — Welcome\n/memory — View my memory of you\n/cellar — Your cellar inventory\n/watchlist — Your tracked wines\n/add [wine, region, price, currency] — Track a wine\n/remove [number] — Remove from watchlist\n/alerts — Toggle daily & weekly alerts\n/forget — Clear all memory\n/clear — Reset conversation only\n/help — This message\n\n*Just talk naturally for everything else.*\nSend photos 📸, voice notes 🎙, wine lists, auction lots — I handle it all.`
  );
});

// ─── Photo handler ────────────────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || "";
  bot.sendChatAction(chatId, "typing");
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
    const imageResponse = await fetch(fileUrl);
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString("base64");
    const reply = await getReplyWithImage(chatId, base64Image, caption);
    await sendReply(chatId, reply);
  } catch (error) {
    console.error("Photo error:", error);
    sendReply(chatId, "I had trouble reading that image — please try again. 🙏");
  }
});

// ─── Voice handler ────────────────────────────────────────────────────────────
bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  try {
    const file = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

    // Download audio
    const audioResponse = await fetch(fileUrl);
    const arrayBuffer = await audioResponse.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Use Whisper via OpenAI if key exists, otherwise ask user to type
    if (process.env.OPENAI_API_KEY) {
      const FormData = require("form-data");
      const form = new FormData();
      form.append("file", audioBuffer, { filename: "voice.ogg", contentType: "audio/ogg" });
      form.append("model", "whisper-1");

      const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
        body: form,
      });
      const whisperData = await whisperRes.json();
      const transcription = whisperData.text;

      if (transcription) {
        await sendReply(chatId, `_🎙 I heard: "${transcription}"_`);
        const reply = await getReply(chatId, transcription);
        await sendReply(chatId, reply);
      } else {
        sendReply(chatId, "I couldn't transcribe that voice note. Please try again or type your message.");
      }
    } else {
      // No Whisper — inform user
      sendReply(chatId, "🎙 I received your voice message! To enable voice transcription, add an `OPENAI_API_KEY` to your Railway variables.\n\nFor now, please type your question and I'll answer right away.");
    }
  } catch (error) {
    console.error("Voice error:", error);
    sendReply(chatId, "I had trouble with that voice note — please try typing instead. 🙏");
  }
});

// ─── Text message handler ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  bot.sendChatAction(chatId, "typing");
  try {
    const reply = await getReply(chatId, text);
    await sendReply(chatId, reply);
  } catch (error) {
    console.error("Message error:", error);
    sendReply(chatId, "I had a brief issue — please try again. 🙏");
  }
});

console.log("🍷 Jean Le Sommelier v3 running — memory, photos, voice, alerts, weekly digest.");
