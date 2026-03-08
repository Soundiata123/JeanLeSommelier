# 🍷 CAVE — Personal Wine Agent v2

A conversational AI wine agent for Telegram with **real-time market search** and **daily proactive alerts**.

## What's New in v2
- 🔍 **Real-time web search** — searches live auction prices and market data on demand
- 🌅 **Daily morning alerts** — proactively messages you at 9am with market updates for your watchlist
- 🌍 **Global expert persona** — deep knowledge of every major wine region worldwide
- 📋 **Watchlist management** — track wines with target prices via simple commands

---

## Setup Guide (~20 minutes, effectively free)

### Step 1 — Create your Telegram Bot (2 min)
1. Open Telegram → search **@BotFather**
2. Send `/newbot`
3. Pick a name (e.g. `My Wine Agent`) and username (e.g. `mywineagent_bot`)
4. Copy the **token** BotFather gives you

### Step 2 — Get your Anthropic API Key (2 min)
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up / log in
3. Click **API Keys → Create Key** → copy it

### Step 3 — Push to GitHub (5 min)
1. Go to [github.com](https://github.com) → **New Repository** → name it `cave-wine-bot`
2. Upload these 3 files: `bot.js`, `package.json`, `README.md`

### Step 4 — Deploy on Railway (5 min)
1. Go to [railway.app](https://railway.app) → sign up with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `cave-wine-bot` repo
4. Go to **Variables** tab and add:
   ```
   TELEGRAM_TOKEN=your_token_from_botfather
   ANTHROPIC_API_KEY=your_anthropic_key
   ```
5. Click **Deploy** ✅

### Step 5 — Start chatting!
1. Find your bot in Telegram by its username
2. Send `/start`
3. Send `/alerts` to enable daily morning market updates

---

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome message + reset conversation |
| `/watchlist` | View your tracked wines |
| `/add Wine, Region, Price, Currency` | Add wine to watchlist |
| `/remove 1` | Remove wine by number |
| `/alerts` | Toggle daily 9am market alerts |
| `/clear` | Reset conversation history |
| `/help` | All commands |

## Example Usage

**Restaurant recommendation:**
> "Here's the wine list: Barolo Giacomo Conterno 2016 €280, Château Lynch-Bages 2018 €190, Ornellaia 2019 €220. I'm having the wagyu. Budget €250."

**Auction analysis:**
> "Sotheby's lot: 6 bottles Pétrus 2000, estimate $18,000–22,000. Good buy?"

**Add to watchlist:**
> `/add Sassicaia 2019, Bolgheri, 250, EUR`

**Enable alerts:**
> `/alerts` → you'll get a daily 9am message with live price movements

---

## Cost Estimate (personal use)
- **Railway**: Free tier ($5 credit/month, more than enough)
- **Anthropic API**: ~$0.02–0.10 per conversation (very low)
- **Total**: Effectively free for personal use
