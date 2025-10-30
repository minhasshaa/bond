// index.js - REST API VERSION (STABLE & RELIABLE)
// ------------------ DEPENDENCIES ------------------
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const Binance = require("node-binance-api");
const jwt = require('jsonwebtoken'); 
const axios = require('axios');
// >>> START KYC ADDITIONS <<<
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
// >>> END KYC ADDITIONS <<<

// ------------------ CONFIG & CONSTANTS ------------------
const TRADE_PAIRS = [
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
    'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];
module.exports.TRADE_PAIRS = TRADE_PAIRS;

// admin override flags (kept in main server since candle generator uses them)
const candleOverride = {};
TRADE_PAIRS.forEach(pair => { candleOverride[pair] = null; });
module.exports.candleOverride = candleOverride;

// >>> START RATE LIMIT PROTECTION <<<
let binanceRateLimited = false;
let lastBinanceError = null;
const RATE_LIMIT_DELAY = 60000; // 1 minute delay when rate limited
// >>> END RATE LIMIT PROTECTION <<<

// >>> START AZURE CONFIGURATION <<<
const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const KYC_CONTAINER_NAME = process.env.KYC_CONTAINER_NAME || 'id-document-uploads';

let blobServiceClient = null;
let azureEnabled = false; 

if (STORAGE_ACCOUNT_NAME && STORAGE_ACCOUNT_KEY) {
    try {
        const sharedKeyCredential = new StorageSharedKeyCredential(
            STORAGE_ACCOUNT_NAME,
            STORAGE_ACCOUNT_KEY
        );
        blobServiceClient = new BlobServiceClient(
            `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
            sharedKeyCredential
        );
        azureEnabled = true;
        console.log("✅ Azure Blob Storage Client Initialized (Enabled).");
    } catch (e) {
        console.error("❌ Azure Client Initialization failed. KYC upload will be disabled.", e.message);
        blobServiceClient = null;
        azureEnabled = false;
    }
} else {
    console.warn("⚠️ WARNING: Azure Storage credentials not found. KYC upload will be disabled.");
}
// >>> END AZURE CONFIGURATION <<<

// ------------------ MODELS & ROUTES ------------------
const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");
const Message = require('./models/Message'); 

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");
const kycRoutes = require("./routes/kyc"); 

// ------------------ APP + SERVER + IO ------------------
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const marketData = {};
const ticker24hData = {}; 

TRADE_PAIRS.forEach(pair => {
    marketData[pair] = { currentPrice: 0, candles: [], currentCandle: null };
    ticker24hData[pair] = { changePercent: 0 };
});

module.exports.marketData = marketData;
app.set('marketData', marketData);

// ------------------ BINANCE CLIENT ------------------
const binance = new Binance().options({
    APIKEY: process.env.BINANCE_API_KEY,
    APISECRET: process.env.BINANCE_API_SECRET
});

// ------------------ MIDDLEWARE ------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);

app.use("/api/admin", adminRoutes({ blobServiceClient, KYC_CONTAINER_NAME, STORAGE_ACCOUNT_NAME, STORAGE_ACCOUNT_KEY, azureEnabled }));

app.use("/api/withdraw", withdrawRoutes);

app.use("/api/kyc", kycRoutes({ blobServiceClient, KYC_CONTAINER_NAME, azureEnabled }));

// --------------------------------------------------------------------------------------------------
// ⭐ FETCH 24H TICKER DATA
// --------------------------------------------------------------------------------------------------
async function fetchAndStore24hTicker() {
    if (binanceRateLimited) {
        console.log("⏳ Skipping 24h ticker fetch - Binance rate limited");
        return;
    }

    const API_URL = 'https://api.binance.com/api/v3/ticker/24hr';
    
    try {
        const response = await axios.get(API_URL); 
        const tickers = response.data;

        if (!tickers || !Array.isArray(tickers)) return;

        for (const ticker of tickers) {
            if (TRADE_PAIRS.includes(ticker.symbol)) {
                ticker24hData[ticker.symbol] = {
                    changePercent: parseFloat(ticker.priceChangePercent) 
                };
            }
        }
        console.log(`✅ Updated 24h Ticker Data for ${TRADE_PAIRS.length} pairs.`);

    } catch (err) {
        if (err.response && err.response.status === 418 || err.response.status === 429) {
            console.error("❌ Rate limited on 24h ticker data");
            handleBinanceRateLimit();
        } else {
            console.error("❌ Failed to fetch 24h ticker data:", err.message);
        }
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ RATE LIMIT HANDLER
// --------------------------------------------------------------------------------------------------
function handleBinanceRateLimit() {
    if (!binanceRateLimited) {
        binanceRateLimited = true;
        console.log(`🚨 BINANCE RATE LIMIT DETECTED! Pausing API calls for ${RATE_LIMIT_DELAY/1000} seconds`);
        
        setTimeout(() => {
            binanceRateLimited = false;
            console.log("✅ Binance rate limit cooldown complete. Resuming API calls.");
        }, RATE_LIMIT_DELAY);
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ INITIALIZE MARKET DATA (WITH PROPER ERROR HANDLING)
// --------------------------------------------------------------------------------------------------
async function initializeMarketData() {
    console.log("📈 Initializing market data from Binance...");
    await fetchAndStore24hTicker(); 
    
    for (const pair of TRADE_PAIRS) {
        if (binanceRateLimited) {
            console.log(`⏳ Skipping ${pair} initialization - Binance rate limited`);
            marketData[pair].candles = [];
            marketData[pair].currentPrice = getFallbackPrice(pair);
            continue;
        }

        try {
            const klines = await binance.futuresCandles(pair, '1m', { limit: 200 });
            
            // ✅ PROPER ARRAY VALIDATION
            if (!Array.isArray(klines)) {
                console.error(`❌ Binance returned non-array response for ${pair}:`, typeof klines);
                if (klines && klines.code === -1003) {
                    console.error(`🚨 BINANCE BAN DETECTED: ${klines.msg}`);
                    handleBinanceRateLimit();
                }
                marketData[pair].candles = [];
                marketData[pair].currentPrice = getFallbackPrice(pair);
                continue;
            }
            
            // ✅ PROPER KLINE STRUCTURE VALIDATION
            if (klines.length > 0 && (!Array.isArray(klines[0]) || klines[0].length < 5)) {
                console.error(`❌ Invalid kline structure for ${pair}`);
                marketData[pair].candles = [];
                marketData[pair].currentPrice = getFallbackPrice(pair);
                continue;
            }
            
            marketData[pair].candles = klines.map(k => ({
                asset: pair,
                timestamp: new Date(k[0]),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
            }));
            
            const lastCandle = marketData[pair].candles[marketData[pair].candles.length - 1];
            marketData[pair].currentPrice = lastCandle.close;
            console.log(`✅ Loaded ${marketData[pair].candles.length} historical candles for ${pair}.`);
        } catch (err) {
            console.error(`❌ Failed to load initial candles for ${pair}: ${err.message}`);
            if (err.body && err.body.code === -1003) {
                console.error(`🚨 BINANCE BAN DETECTED: ${err.body.msg}`);
                handleBinanceRateLimit();
            }
            marketData[pair].candles = [];
            marketData[pair].currentPrice = getFallbackPrice(pair);
        }
        
        // Small delay between pairs to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ FALLBACK PRICES (WHEN BINANCE IS UNAVAILABLE)
// --------------------------------------------------------------------------------------------------
function getFallbackPrice(pair) {
    const fallbackPrices = {
        'BTCUSDT': 35000,
        'ETHUSDT': 1800,
        'BNBUSDT': 230,
        'SOLUSDT': 35,
        'XRPUSDT': 0.55,
        'ADAUSDT': 0.25,
        'DOGEUSDT': 0.07,
        'AVAXUSDT': 12,
        'LINKUSDT': 7,
        'MATICUSDT': 0.6
    };
    return fallbackPrices[pair] || 1;
}

// --------------------------------------------------------------------------------------------------
// ⭐ UPDATE MARKET DATA (ORIGINAL RELIABLE VERSION)
// --------------------------------------------------------------------------------------------------
async function updateMarketData() {
    if (binanceRateLimited) {
        // Use fallback data when rate limited
        updateMarketDataWithFallback();
        return;
    }

    try {
        const prices = await binance.futuresPrices();
        
        if (!prices || typeof prices !== 'object') {
            console.error("❌ Invalid prices response from Binance");
            return;
        }
        
        const now = new Date();
        const currentMinuteStart = new Date(now);
        currentMinuteStart.setSeconds(0, 0);
        currentMinuteStart.setMilliseconds(0);

        for (const pair of TRADE_PAIRS) {
            if (prices[pair]) marketData[pair].currentPrice = parseFloat(prices[pair]);

            const md = marketData[pair];
            const currentPrice = md.currentPrice || 0;
            if (!currentPrice) continue;

            // ✅ Ensure candles array exists
            if (!Array.isArray(md.candles)) {
                md.candles = [];
            }

            const isNewMinute = !md.currentCandle || md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime();

            if (isNewMinute) {
                if (md.currentCandle) {
                    const completed = { ...md.currentCandle, close: currentPrice };
                    const override = candleOverride[pair];
                    if (override) {
                        const openP = completed.open;
                        const priceChange = openP * 0.00015 * (Math.random() + 0.5);
                        if (override === 'up') {
                            completed.close = openP + priceChange;
                            completed.high = Math.max(completed.high, completed.close);
                        } else {
                            completed.close = openP - priceChange;
                            completed.low = Math.min(completed.low, completed.close);
                        }
                        console.log(`🔴 OVERRIDE: Forcing ${pair} to CLOSE ${override.toUpperCase()} => ${completed.close.toFixed(6)}`);
                        candleOverride[pair] = null;
                    }
                    md.candles.push(completed);
                    if (md.candles.length > 200) md.candles.shift();
                    try {
                        await Candle.updateOne({ asset: pair, timestamp: completed.timestamp }, { $set: completed }, { upsert: true });
                    } catch (dbError) {
                        console.error(`❌ Database error saving candle for ${pair}:`, dbError.message);
                    }
                }
                md.currentCandle = { asset: pair, timestamp: currentMinuteStart, open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice };
            } else {
                md.currentCandle.high = Math.max(md.currentCandle.high, currentPrice);
                md.currentCandle.low = Math.min(md.currentCandle.low, currentPrice);
                md.currentCandle.close = currentPrice;
            }
            const allCandles = [...md.candles, md.currentCandle];
            io.emit("market_data", { asset: pair, candles: allCandles, currentPrice: currentPrice });
        }
    } catch (err) {
        console.error("❌ Error in updateMarketData:", err.message);
        if (err.body && err.body.code === -1003) {
            handleBinanceRateLimit();
        }
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ FALLBACK MARKET DATA UPDATE
// --------------------------------------------------------------------------------------------------
function updateMarketDataWithFallback() {
    const now = new Date();
    const currentMinuteStart = new Date(now);
    currentMinuteStart.setSeconds(0, 0);
    currentMinuteStart.setMilliseconds(0);

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        let currentPrice = md.currentPrice || getFallbackPrice(pair);
        
        // Small random price movement for fallback mode
        currentPrice = currentPrice * (1 + (Math.random() - 0.5) * 0.001);
        md.currentPrice = currentPrice;

        if (!Array.isArray(md.candles)) {
            md.candles = [];
        }

        const isNewMinute = !md.currentCandle || md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime();

        if (isNewMinute) {
            if (md.currentCandle) {
                const completed = { ...md.currentCandle, close: currentPrice };
                const override = candleOverride[pair];
                if (override) {
                    const openP = completed.open;
                    const priceChange = openP * 0.00015 * (Math.random() + 0.5);
                    if (override === 'up') {
                        completed.close = openP + priceChange;
                        completed.high = Math.max(completed.high, completed.close);
                    } else {
                        completed.close = openP - priceChange;
                        completed.low = Math.min(completed.low, completed.close);
                    }
                    console.log(`🔴 OVERRIDE: Forcing ${pair} to CLOSE ${override.toUpperCase()} => ${completed.close.toFixed(6)}`);
                    candleOverride[pair] = null;
                }
                md.candles.push(completed);
                if (md.candles.length > 200) md.candles.shift();
            }
            md.currentCandle = { asset: pair, timestamp: currentMinuteStart, open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice };
        } else {
            md.currentCandle.high = Math.max(md.currentCandle.high, currentPrice);
            md.currentCandle.low = Math.min(md.currentCandle.low, currentPrice);
            md.currentCandle.close = currentPrice;
        }
        const allCandles = [...md.candles, md.currentCandle];
        io.emit("market_data", { asset: pair, candles: allCandles, currentPrice: currentPrice });
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ START POLLING (ORIGINAL TIMINGS)
// --------------------------------------------------------------------------------------------------
function startMarketDataPolling() {
    console.log("✅ Starting market data polling every 2 seconds...");
    // Update every 2 seconds for real-time price updates (less aggressive)
    setInterval(updateMarketData, 2000); 
    // Fetch 24h ticker data every 2 minutes
    setInterval(fetchAndStore24hTicker, 120000); 
}

// [REST OF THE CODE REMAINS EXACTLY THE SAME AS YOUR WORKING VERSION]

// ----- DASHBOARD DATA FUNCTIONS -----
async function getDashboardData(userId) {
    const user = await User.findById(userId).select('username balance');
    if (!user) {
        throw new Error('User not found.');
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const recentTrades = await Trade.find({ 
        userId: userId, 
        status: 'closed',
        closeTime: { $gte: startOfToday } 
    });

    const todayPnl = recentTrades.reduce((total, trade) => total + (trade.pnl || 0), 0);

    const assets = TRADE_PAIRS;
    const marketInfo = assets.map(pair => {
        const data = marketData[pair];
        if (!data || typeof data.currentPrice !== 'number') return null;

        const changeValue = ticker24hData[pair] ? ticker24hData[pair].changePercent : 0;

        return {
            name: pair.replace('USDT', ''),
            ticker: `${pair.replace('USDT', '')}/USD`,
            price: data.currentPrice,
            change: parseFloat(changeValue.toFixed(2)),
            candles: data.candles
        };
    }).filter(Boolean);

    return {
        username: user.username,
        balance: user.balance,
        todayPnl: parseFloat(todayPnl.toFixed(2)),
        recentTrades: [], 
        assets: marketInfo
    };
}

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Authentication Error: Token not provided."));
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded; 
        next();
    } catch (ex) {
        return next(new Error("Authentication Error: Invalid token."));
    }
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    if (socket.decoded && socket.decoded.id) {
        socket.join(socket.decoded.id);
        console.log(`Socket ${socket.id} (dashboard) joined room ${socket.decoded.id}`);
    }

    socket.on('request_dashboard_data', async () => {
        try {
            const userId = socket.decoded.id;
            const dashboardData = await getDashboardData(userId);
            socket.emit('dashboard_data', { success: true, data: dashboardData });
        } catch (error) {
            console.error('Socket error fetching dashboard data:', error.message);
            socket.emit('dashboard_data', { success: false, message: 'Could not fetch dashboard data.' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// ------------------ PRICE UPDATE BROADCAST ------------------
setInterval(() => {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadDashboard = {};
    const payloadTrading = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        const changeValue = ticker24hData[pair] ? ticker24hData[pair].changePercent : 0;
        
        // Dashboard format
        const tickerForClient = `${pair.replace('USDT', '')}/USD`;
        payloadDashboard[tickerForClient] = {
            price: md.currentPrice,
            change: parseFloat(changeValue.toFixed(2)), 
            countdown: secondsUntilNextMinute
        };

        // Trading format
        payloadTrading[pair] = {
            price: md.currentPrice,
            countdown: secondsUntilNextMinute,
            timestamp: now.getTime()
        };
    }

    io.emit("price_update", payloadTrading);         
    io.emit("dashboard_price_update", payloadDashboard);
}, 1000);

// ------------------ DB + STARTUP ------------------
mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log("✅ Connected to MongoDB");
}).catch(err => {
    console.error("❌ MongoDB connection error:", err);
});

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));

db.once("open", async () => {
    console.log("✅ Connected to MongoDB");

    try {
        const TradeModel = mongoose.model('Trade');
        const UserModel = mongoose.model('User');
        
        const tradeUpdateResult = await TradeModel.updateMany(
            { 
                status: { $ne: 'closed' },
                $or: [
                    { activationTimestamp: { $not: { $type: 9 } } },
                    { activationTimestamp: { $exists: false } }, 
                    { activationTimestamp: null } 
                ]
            },
            { 
                $set: { 
                    status: 'closed', 
                    closeTime: new Date(),
                    pnl: 0 
                } 
            }
        );
        console.log(`🧹 Safely closed ${tradeUpdateResult.modifiedCount} corrupted trade records.`);

        const userUpdateResult = await UserModel.updateMany(
            { $or: [{ createdAt: { $not: { $type: 9 } } }, { createdAt: { $exists: false } }, { createdAt: null }] },
            { $set: { createdAt: new Date() } }
        );
        console.log(`🧹 Safely fixed ${userUpdateResult.modifiedCount} corrupted user date records.`);

    } catch (error) {
        console.error("Warning: Pre-boot database cleanup failed. Proceeding with trade initialization.", error.message);
    }

    await initializeMarketData();
    startMarketDataPolling();

    const tradeModule = require("./trade");
    if (typeof tradeModule.initialize === "function") {
        tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
    } else if (typeof tradeModule === "function") {
        tradeModule(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
    } else {
        console.error("Trade module export not recognized. Expected function or object with initialize()");
    }
});

// ------------------ CATCH-ALL / STATIC SERVE ------------------
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API endpoint not found.' });
    const filePath = path.join(__dirname, 'public', req.path);
    if (req.path.includes('..')) return res.status(403).send('Forbidden');
    res.sendFile(filePath, (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Server is running and listening on port ${PORT}`));
