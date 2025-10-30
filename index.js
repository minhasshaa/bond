// index.js - WITH BINANCE WEBSOCKET INSTEAD OF REST API
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

// >>> START WEBSOCKET STATE MANAGEMENT <<<
const wsConnections = {};
let isWebSocketConnected = false;
// >>> END WEBSOCKET STATE MANAGEMENT <<<

// >>> START AZURE CONFIGURATION (CLEANED) <<<
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
    APISECRET: process.env.BINANCE_API_SECRET,
    reconnect: true,
    verbose: true
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
// ⭐ WEBSOCKET FUNCTIONS - REAL-TIME DATA WITHOUT RATE LIMITING
// --------------------------------------------------------------------------------------------------

// Initialize WebSocket connections for all trading pairs
function initializeBinanceWebSockets() {
    console.log("🔌 Initializing Binance WebSocket connections...");
    
    TRADE_PAIRS.forEach(pair => {
        try {
            // WebSocket for real-time ticker data
            binance.websockets.ticker(pair, (ticker) => {
                if (ticker && ticker.curDayClose !== undefined) {
                    const currentPrice = parseFloat(ticker.curDayClose);
                    marketData[pair].currentPrice = currentPrice;
                    
                    // Update candle data in real-time
                    updateCandleWithWebSocketData(pair, currentPrice);
                    
                    // Emit real-time updates to clients
                    io.emit("price_update", {
                        [pair]: {
                            price: currentPrice,
                            timestamp: Date.now()
                        }
                    });
                }
            });
            
            // WebSocket for kline/candle data (optional - for candle sticks)
            binance.websockets.candlesticks(pair, '1m', (candlesticks) => {
                const { k: kline } = candlesticks;
                if (kline && kline.x) { // kline.x is true when candle is closed
                    const newCandle = {
                        asset: pair,
                        timestamp: new Date(kline.t),
                        open: parseFloat(kline.o),
                        high: parseFloat(kline.h),
                        low: parseFloat(kline.l),
                        close: parseFloat(kline.c)
                    };
                    
                    // Add to candles array
                    marketData[pair].candles.push(newCandle);
                    if (marketData[pair].candles.length > 200) {
                        marketData[pair].candles.shift();
                    }
                    
                    // Save to database
                    Candle.updateOne(
                        { asset: pair, timestamp: newCandle.timestamp },
                        { $set: newCandle },
                        { upsert: true }
                    ).catch(err => console.error(`Database error for ${pair}:`, err.message));
                    
                    // Emit updated candles to clients
                    io.emit("market_data", {
                        asset: pair,
                        candles: marketData[pair].candles,
                        currentPrice: marketData[pair].currentPrice
                    });
                }
            });
            
            console.log(`✅ WebSocket connected for ${pair}`);
            
        } catch (error) {
            console.error(`❌ WebSocket connection failed for ${pair}:`, error.message);
        }
    });
    
    isWebSocketConnected = true;
    console.log("🎯 All WebSocket connections established - Real-time data streaming active");
}

// Update candle data with WebSocket price updates
function updateCandleWithWebSocketData(pair, currentPrice) {
    const md = marketData[pair];
    const now = new Date();
    const currentMinuteStart = new Date(now);
    currentMinuteStart.setSeconds(0, 0);
    currentMinuteStart.setMilliseconds(0);

    if (!md.currentCandle || md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime()) {
        // New minute - close previous candle and start new one
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
        
        // Start new candle
        md.currentCandle = {
            asset: pair,
            timestamp: currentMinuteStart,
            open: currentPrice,
            high: currentPrice,
            low: currentPrice,
            close: currentPrice
        };
    } else {
        // Update current candle with new price
        md.currentCandle.high = Math.max(md.currentCandle.high, currentPrice);
        md.currentCandle.low = Math.min(md.currentCandle.low, currentPrice);
        md.currentCandle.close = currentPrice;
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ UPDATED: Initialize Market Data (Minimal REST calls for initial setup)
// --------------------------------------------------------------------------------------------------
async function initializeMarketData() {
    console.log("📈 Initializing market data...");
    
    // Only use REST API for initial historical data (once)
    await fetchInitialHistoricalData();
    
    // Start WebSocket connections for real-time data
    initializeBinanceWebSockets();
    
    // Fetch 24h data once (this can stay as it's less frequent)
    await fetchAndStore24hTicker();
}

// Fetch initial historical data (only once during startup)
async function fetchInitialHistoricalData() {
    console.log("📊 Fetching initial historical data...");
    
    for (const pair of TRADE_PAIRS) {
        try {
            const klines = await binance.futuresCandles(pair, '1m', { limit: 100 });
            
            if (Array.isArray(klines) && klines.length > 0) {
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
            }
        } catch (err) {
            console.error(`❌ Failed initial load for ${pair}:`, err.message);
            // Continue with empty data - WebSocket will populate real-time data
        }
        
        // Small delay to avoid rate limiting during initial setup
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ KEEP: 24h Ticker Data (Less frequent - okay to keep as REST)
// --------------------------------------------------------------------------------------------------
async function fetchAndStore24hTicker() {
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
        console.error("❌ Failed to fetch 24h ticker data:", err.message);
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ REMOVED: No more polling intervals for market data!
// --------------------------------------------------------------------------------------------------
function startMarketDataPolling() {
    console.log("✅ WebSocket real-time data streaming active - No polling needed");
    
    // Only keep the 24h data update (less frequent)
    setInterval(fetchAndStore24hTicker, 300000); // Every 5 minutes
}

// [REST OF THE CODE REMAINS LARGELY THE SAME - DASHBOARD FUNCTIONS, SOCKET.IO, ETC.]

// ----- DASHBOARD DATA FUNCTIONS START -----
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

// ------------------ PRICE UPDATE BROADCAST (SIMPLIFIED) ------------------
// WebSocket handles real-time updates, this is just for countdown
setInterval(() => {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadDashboard = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        const changeValue = ticker24hData[pair] ? ticker24hData[pair].changePercent : 0;
        
        const tickerForClient = `${pair.replace('USDT', '')}/USD`;
        payloadDashboard[tickerForClient] = {
            price: md.currentPrice,
            change: parseFloat(changeValue.toFixed(2)), 
            countdown: secondsUntilNextMinute
        };
    }

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
