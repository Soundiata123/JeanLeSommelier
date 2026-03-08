const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory storage ────────────────────────────────────────────────────────
const conversations = {};   // { chatId: [ {role, content}, ... ] }
const watchlists    = {};   // { chatId: [ { wine, region, targetPrice, currency }, ... ] }
const alertUsers    = new Set(); // chatIds with daily alerts enabled
const MAX_HISTORY   = 30;

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are CAVE — the world's most authoritative personal wine agent. You combine the expertise of a Master Sommelier (MS), Master of Wine (MW), and seasoned wine auction specialist into one trusted advisor.

## Your Global Expertise Covers:

**Old World**
- France: All 37 AOCs of Bordeaux (Left & Right Bank), every Premier & Grand Cru of Burgundy, Champagne houses & growers, Northern & Southern Rhône, Loire, Alsace, Languedoc
- Italy: Barolo, Barbaresco, Brunello, Amarone, Sassicaia, Ornellaia, all Supertuscans, Chianti Classico, Etna
- Spain: Rioja, Ribera del Duero, Priorat, Albariño, Jerez, Cava
- Germany: Mosel Riesling, Rheingau, all Prädikat levels, VDP estates
- Portugal: Douro, Dão, Alentejo, Vinho Verde, Vintage Port, Colheita
- Austria, Greece, Hungary (Tokaji), Georgia (Qvevri), Lebanon (Château Musar)

**New World**
- USA: All Napa AVAs (Stags Leap, Rutherford, Oakville, Howell Mountain, Spring Mountain), Sonoma, Oregon Pinot, Washington Syrah, Central Coast
- Australia: Penfolds full lineup, Henschke Hill of Grace, Barossa, Clare Valley, Margaret River, Yarra Valley, Hunter Valley
- New Zealand: Marlborough, Central Otago, Hawke's Bay
- South America: Mendoza Malbec, Chilean Carménère, Uruguayan Tannat
- South Africa: Stellenbosch, Swartland, Eben Sadie, Boekenhoutskloof

**Auction & Investment Markets**
- Deep knowledge of Sotheby's, Christie's, Hart Davis Hart, Zachys, Acker Merrall & Condit, Bonhams, iDealwine
- Market cycles, seasonal auction patterns (NY/London/HK spring & autumn sales)
- Investment-grade wines, en primeur, provenance & storage impact on value
- Cult wines: Screaming Eagle, Harlan, Petrus, DRC, Leroy, Giacomo Conterno, Soldera, Sine Qua Non

**Additional Expertise**
- Vintage charts for every major region going back 50 years
- Michelin-level food and wine pairing
- Cellar management and aging potential for any wine
- Natural, biodynamic, and organic wine movements

## How You Behave:
- Confident and precise — you never hedge unnecessarily
- Warm and personal — you remember the user's watchlist and preferences from this conversation
- Proactive — if someone mentions a dinner, ask for the menu; if they mention an auction, ask for the listing
- Global perspective — you naturally reference comparable wines across regions
- When asked about current prices or recent auction results, use your web search tool to get live data

## Formatting for Telegram:
- Use *bold* for wine names, verdicts, and key points
- Keep paragraphs short and scannable
- Use emojis sparingly (🍷🍾🌍🔨📈) — only when meaningful
- For auction verdicts always lead with: *BUY / PASS / WATCH*
- For restaurant picks always give a *Top Pick* and *Runner-Up*`;

// ─── Claude API call with web search ─────────────────────────────────────────
async function getReply(chatId, userMessage) {
  if (!conversations[chatId]) conversations[chatId] = [];

  // Inject watchlist context
  let contextMessage = userMessage;
  const wl = watchlists[chatId];
  if (wl && wl.length > 0) {
    const wlSummary = wl.map(w => `${w.wine} (target ${w.currency} ${w.targetPrice})`).join(", ");
    contextMessage = `[User watchlist: ${wlSummary}]\n\n${userMessage}`;
  }

  conversations[chatId].push({ role: "user", content: contextMessage });
  if (conversations[chatId].length > MAX_HISTORY) {
    conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
  }

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: conversations[chatId],
  });

  // Collect all text blocks (web search results are auto-handled by the API)
  const finalText = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  conversations[chatId].push({ role: "assistant", content: finalText || "I couldn't generate a response. Please try again." });
  return finalText || "I couldn't generate a response. Please try again.";
}

// ─── Watchlist helpers ────────────────────────────────────────────────────────
function addToWatchlist(chatId, wine, region, targetPrice, currency = "USD") {
  if (!watchlists[chatId]) watchlists[chatId] = [];
  watchlists[chatId].push({
    wine, region: region || "Unknown",
    targetPrice: parseFloat(targetPrice) || 0,
    currency: currency.toUpperCase() || "USD",
    addedAt: new Date().toISOString().split("T")[0],
  });
}

function removeFromWatchlist(chatId, index) {
  if (watchlists[chatId]?.[index] !== undefined) {
    return watchlists[chatId].splice(index, 1)[0];
  }
  return null;
}

// ─── Daily alert scheduler (runs every day at 9am) ────────────────────────────
cron.schedule("0 9 * * *", async () => {
  console.log(`[${new Date().toISOString()}] Running daily alert check for ${alertUsers.size} users...`);

  for (const chatId of alertUsers) {
    const wl = watchlists[chatId] || [];

    try {
      let alertPrompt;
      if (wl.length > 0) {
        const wlText = wl.map((w, i) => `${i + 1}. ${w.wine} (${w.region}) — Target: ${w.currency} ${w.targetPrice}`).join("\n");
        alertPrompt = `Search for recent auction results and current market prices for these wines:\n${wlText}\n\nWrite a brief morning market update (max 180 words) covering:\n- Notable recent sales or price movements for any of these wines\n- Whether any are currently near or below target price\n- Any upcoming auctions worth watching for these wines\nIf you find specific recent prices, include them. If nothing notable, say the market is quiet. Sign off as CAVE.`;
      } else {
        alertPrompt = `Search for notable wine auction news, significant recent sales, or interesting market developments today. Write a brief morning wine market briefing (max 150 words) covering 2-3 interesting items — notable sales, upcoming auctions, or market trends. Sign off as CAVE.`;
      }

      const response = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: alertPrompt }],
      });

      const alertText = response.content.filter(b => b.type === "text").map(b => b.text).join("") ||
        "Markets are quiet today. No major movements to report. Good time to be patient. 🍷";

      await bot.sendMessage(
        chatId,
        `🌅 *Morning Wine Market Update*\n\n${alertText}`,
        { parse_mode: "Markdown" }
      );

    } catch (err) {
      console.error(`Alert error for ${chatId}:`, err.message);
    }
  }
});

// ─── Telegram commands ────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "there";
  conversations[chatId] = [];
  bot.sendMessage(chatId,
    `🍷 *Welcome to CAVE, ${name}.*\n\nI'm your personal wine agent — Master Sommelier, auction analyst, and global market advisor with real-time search.\n\n*What I can do:*\n• Recommend the perfect bottle from any restaurant list\n• Give BUY / PASS / WATCH on any auction lot\n• Search live prices and recent auction results\n• Track wines on your watchlist\n• Send you daily market alerts every morning\n• Answer anything about wine — any region, any vintage\n\n*Key commands:*\n/watchlist — Your tracked wines\n/add — Track a new wine\n/alerts — Toggle daily alerts\n/help — All commands\n\nWhat can I help you with today?`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/clear/, (msg) => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, "🍾 Conversation cleared. What can I help you with?");
});

bot.onText(/\/watchlist/, (msg) => {
  const chatId = msg.chat.id;
  const wl = watchlists[chatId] || [];
  if (wl.length === 0) {
    bot.sendMessage(chatId,
      "Your watchlist is empty.\n\nUse /add to track wines:\n`/add Château Pétrus 2015, Pomerol, 3500, USD`",
      { parse_mode: "Markdown" }
    );
    return;
  }
  const list = wl.map((w, i) =>
    `${i + 1}. *${w.wine}*\n   ${w.region} — Target: ${w.currency} ${w.targetPrice.toLocaleString()}`
  ).join("\n\n");
  bot.sendMessage(chatId,
    `🍷 *Your Watchlist* (${wl.length} wine${wl.length !== 1 ? "s" : ""})\n\n${list}\n\nRemove a wine: /remove 1`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/add (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].split(",").map(s => s.trim());
  if (parts.length < 2) {
    bot.sendMessage(chatId,
      "Format: `/add Wine Name, Region, TargetPrice, Currency`\n\nExample:\n`/add Château Pétrus 2015, Pomerol, 3500, USD`",
      { parse_mode: "Markdown" }
    );
    return;
  }
  const [wine, region, price, currency] = parts;
  addToWatchlist(chatId, wine, region, price, currency);
  bot.sendMessage(chatId,
    `✅ Added *${wine}* to your watchlist.\n\nEnable /alerts to get daily price updates on this wine.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/remove (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const removed = removeFromWatchlist(chatId, parseInt(match[1]) - 1);
  if (removed) {
    bot.sendMessage(chatId, `🗑 Removed *${removed.wine}* from your watchlist.`, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(chatId, "Wine not found. Use /watchlist to see your list.");
  }
});

bot.onText(/\/alerts/, (msg) => {
  const chatId = msg.chat.id;
  if (alertUsers.has(chatId)) {
    alertUsers.delete(chatId);
    bot.sendMessage(chatId, "🔕 Daily alerts *disabled*. Send /alerts to re-enable.", { parse_mode: "Markdown" });
  } else {
    alertUsers.add(chatId);
    const wl = watchlists[chatId] || [];
    const note = wl.length === 0
      ? "\n\n_Tip: Use /add to track specific wines for personalised alerts._"
      : `\n\nI'll monitor your ${wl.length} watched wine${wl.length !== 1 ? "s" : ""} every morning.`;
    bot.sendMessage(chatId,
      `🔔 Daily alerts *enabled*!\n\nYou'll get a morning market update at 9am — live prices, recent auction results, and buying opportunities.${note}`,
      { parse_mode: "Markdown" }
    );
  }
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*CAVE — Commands*\n\n/start — Welcome & reset conversation\n/watchlist — View your tracked wines\n/add [wine, region, price, currency] — Track a wine\n/remove [number] — Remove from watchlist\n/alerts — Toggle daily 9am market alerts\n/clear — Reset conversation history\n/help — This message\n\n*Just talk naturally for everything else* — share a wine list, paste an auction lot, ask any wine question.`,
    { parse_mode: "Markdown" }
  );
});

// ─── Main message handler ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  bot.sendChatAction(chatId, "typing");

  try {
    const reply = await getReply(chatId, text);
    // Handle Telegram's 4096 char limit
    if (reply.length > 4000) {
      const chunks = reply.match(/.{1,4000}/gs) || [reply];
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    }
  } catch (error) {
    console.error("Message error:", error);
    bot.sendMessage(chatId, "I had a brief issue — please try again. 🙏");
  }
});

console.log("🍷 CAVE Wine Agent running — real-time search + daily alerts enabled.");
