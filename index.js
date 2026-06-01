// index.js - FINAL CORRECTED VERSION
// ------------------ DEPENDENCIES ------------------
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");

// ------------------ CONFIG & CONSTANTS ------------------
const TRADE_PAIRS = [
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
    'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];
module.exports.TRADE_PAIRS = TRADE_PAIRS;

const candleOverride = {};
TRADE_PAIRS.forEach(pair => { candleOverride[pair] = null; });
module.exports.candleOverride = candleOverride;

// ------------------ AZURE CONFIGURATION ------------------
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
        console.log("✅ Azure Blob Storage Client Initialized.");
    } catch (e) {
        console.error("❌ Azure Client Initialization failed.", e.message);
    }
} else {
    console.warn("⚠️ Azure Storage credentials not found. KYC upload disabled.");
}

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

// ------------------ 24H TICKER ------------------
async function fetchAndStore24hTicker() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        const tickers = response.data;
        if (!tickers || !Array.isArray(tickers)) return;
        for (const ticker of tickers) {
            if (TRADE_PAIRS.includes(ticker.symbol)) {
                ticker24hData[ticker.symbol] = {
                    changePercent: parseFloat(ticker.priceChangePercent)
                };
            }
        }
        console.log(`✅ Updated 24h Ticker Data.`);
    } catch (err) {
        if (err.response) {
            console.error(`❌ Failed to fetch 24h ticker (HTTP ${err.response.status}):`, err.message);
        } else {
            console.error("❌ Failed to fetch 24h ticker:", err.message);
        }
    }
}

// ------------------ DASHBOARD DATA ------------------
async function getDashboardData(userId) {
    const user = await User.findById(userId).select('username balance');
    if (!user) throw new Error('User not found.');

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const recentTrades = await Trade.find({
        userId: userId,
        status: 'closed',
        closeTime: { $gte: startOfToday }
    });

    const todayPnl = recentTrades.reduce((total, trade) => total + (trade.pnl || 0), 0);

    const marketInfo = TRADE_PAIRS.map(pair => {
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
        recentTrades: recentTrades.map(trade => ({
            asset: trade.asset,
            pnl: parseFloat((trade.pnl || 0).toFixed(2)),
            result: trade.result
        })),
        assets: marketInfo
    };
}

// ------------------ SOCKET.IO AUTH MIDDLEWARE ------------------
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication Error: Token not provided."));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded;
        next();
    } catch (ex) {
        return next(new Error("Authentication Error: Invalid token."));
    }
});

// ------------------ SOCKET.IO CONNECTION ------------------
// FIX: Rate limiter for dashboard data requests
const dashboardRequestTracker = {};
const DASHBOARD_REQUEST_LIMIT_MS = 5000;

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    if (socket.decoded && socket.decoded.id) {
        socket.join(socket.decoded.id);
        console.log(`Socket ${socket.id} joined room ${socket.decoded.id}`);
    }

    socket.on('request_dashboard_data', async () => {
        try {
            const userId = socket.decoded.id;

            // FIX: Rate limit dashboard data requests
            const now = Date.now();
            if (dashboardRequestTracker[userId] && now - dashboardRequestTracker[userId] < DASHBOARD_REQUEST_LIMIT_MS) {
                return;
            }
            dashboardRequestTracker[userId] = now;

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

// ------------------ MARKET DATA ------------------
async function initializeMarketData() {
    console.log("📈 Initializing market data from Binance...");
    await fetchAndStore24hTicker();

    for (const pair of TRADE_PAIRS) {
        try {
            const response = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=200`);
            const klines = response.data;

            if (!Array.isArray(klines)) {
                console.error(`❌ Failed to load candles for ${pair}: Non-array data received.`);
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
            console.log(`✅ Loaded ${marketData[pair].candles.length} candles for ${pair}.`);

        } catch (err) {
            console.error(`❌ Failed to load candles for ${pair}:`, err.message);
        }
    }
}

async function updateMarketData() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price');
        const tickerPrices = response.data;

        const prices = tickerPrices.reduce((acc, curr) => {
            acc[curr.symbol] = curr.price;
            return acc;
        }, {});

        const now = new Date();
        const currentMinuteStart = new Date(now);
        currentMinuteStart.setSeconds(0, 0);
        currentMinuteStart.setMilliseconds(0);

        for (const pair of TRADE_PAIRS) {
            if (prices[pair]) marketData[pair].currentPrice = parseFloat(prices[pair]);

            const md = marketData[pair];
            const currentPrice = md.currentPrice || 0;
            if (!currentPrice) continue;

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
                        console.log(`🔴 OVERRIDE: ${pair} forced ${override.toUpperCase()} => ${completed.close.toFixed(6)}`);
                        candleOverride[pair] = null;
                    }
                    md.candles.push(completed);
                    if (md.candles.length > 200) md.candles.shift();
                    await Candle.updateOne(
                        { asset: pair, timestamp: completed.timestamp },
                        { $set: completed },
                        { upsert: true }
                    );
                }
                md.currentCandle = {
                    asset: pair,
                    timestamp: currentMinuteStart,
                    open: currentPrice,
                    high: currentPrice,
                    low: currentPrice,
                    close: currentPrice
                };
            } else {
                md.currentCandle.high = Math.max(md.currentCandle.high, currentPrice);
                md.currentCandle.low = Math.min(md.currentCandle.low, currentPrice);
                md.currentCandle.close = currentPrice;
            }

            const allCandles = [...md.candles, md.currentCandle];
            io.emit("market_data", { asset: pair, candles: allCandles, currentPrice });
        }
    } catch (err) {
        console.error("Error in updateMarketData:", err.message);
    }
}

function startMarketDataPolling() {
    console.log("✅ Starting market data polling every second...");
    setInterval(updateMarketData, 1000);
    setInterval(fetchAndStore24hTicker, 60000);
}

// ------------------ PRICE UPDATE BROADCAST ------------------
setInterval(() => {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadDashboard = {};
    const payloadTrading = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        const changeValue = ticker24hData[pair] ? ticker24hData[pair].changePercent : 0;

        const tickerForClient = `${pair.replace('USDT', '')}/USD`;
        payloadDashboard[tickerForClient] = {
            price: md.currentPrice,
            change: parseFloat(changeValue.toFixed(2)),
            countdown: secondsUntilNextMinute
        };

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
mongoose.connect(process.env.MONGO_URI);
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
        console.log(`🧹 Closed ${tradeUpdateResult.modifiedCount} corrupted trade records.`);

        const userUpdateResult = await UserModel.updateMany(
            { $or: [{ createdAt: { $not: { $type: 9 } } }, { createdAt: { $exists: false } }, { createdAt: null }] },
            { $set: { createdAt: new Date() } }
        );
        console.log(`🧹 Fixed ${userUpdateResult.modifiedCount} corrupted user date records.`);

    } catch (error) {
        console.error("Pre-boot cleanup failed. Proceeding anyway.", error.message);
    }

    await initializeMarketData();
    startMarketDataPolling();

    const tradeModule = require("./trade");
    if (typeof tradeModule.initialize === "function") {
        tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
    } else if (typeof tradeModule === "function") {
        tradeModule(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
    } else {
        console.error("Trade module export not recognized.");
    }
});

// ------------------ CATCH-ALL / STATIC SERVE ------------------
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API endpoint not found.' });
    // FIX: Path traversal check BEFORE building file path
    if (req.path.includes('..')) return res.status(403).send('Forbidden');
    const filePath = path.join(__dirname, 'public', req.path);
    res.sendFile(filePath, (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ------------------ KEEP-ALIVE PING ------------------
// Prevents server from sleeping on free hosting (Render, Railway, etc.)
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;

if (KEEP_ALIVE_URL) {
    setInterval(async () => {
        try {
            await axios.get(KEEP_ALIVE_URL);
            console.log(`✅ Keep-alive ping sent to ${KEEP_ALIVE_URL}`);
        } catch (err) {
            console.warn(`⚠️ Keep-alive ping failed:`, err.message);
        }
    }, 14 * 60 * 1000); // Every 14 minutes
    console.log(`✅ Keep-alive initialized for ${KEEP_ALIVE_URL}`);
} else {
    console.warn('⚠️ KEEP_ALIVE_URL not set in .env');
}
