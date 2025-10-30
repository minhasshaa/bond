// index.js - COMPLETE CODE WITH WEBSOCKET FIX AND ALL FUNCTIONS INCLUDED
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

// Utility function to introduce a delay for rate limiting sensitive calls
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)); 

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
// ⭐ 24h Ticker Data Function (REST API - Run every 60s)
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
        if (err.response && err.response.status === 418) {
             console.error("❌ Failed to fetch 24h ticker data (HTTP 418 - I'm a teapot): LIKELY RATE LIMITED by Binance. Consider reducing frequency.");
        } else {
             console.error("❌ Failed to fetch 24h ticker data (Axios Error):", err.message);
        }
    }
}
// --------------------------------------------------------------------------------------------------


// ----- DASHBOARD DATA FUNCTIONS START (RE-INCLUDED) -----
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
// ----- DASHBOARD DATA FUNCTIONS END -----


// --------------------------------------------------------------------------------------------------
// ⭐ NEW FUNCTION: Process real-time price update from WebSocket (Replaces updateMarketData polling)
// --------------------------------------------------------------------------------------------------
async function processPriceUpdate(priceData) {
    const now = new Date();
    const currentMinuteStart = new Date(now);
    currentMinuteStart.setSeconds(0, 0);
    currentMinuteStart.setMilliseconds(0);

    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadDashboard = {};
    const payloadTrading = {};
    let shouldBroadcast = false;

    // Process price updates for all traded pairs
    for (const pair of TRADE_PAIRS) {
        // Find the price in the incoming Mini Ticker stream data
        const priceItem = priceData.find(item => item.s === pair);
        if (!priceItem) continue;

        const currentPrice = parseFloat(priceItem.c);
        if (isNaN(currentPrice)) continue;

        marketData[pair].currentPrice = currentPrice;
        const md = marketData[pair];
        shouldBroadcast = true; // Flag to broadcast once any price changes

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
                        completed.low = Math.min(completed.low, completed.currentPrice);
                    }
                    console.log(`🔴 OVERRIDE: Forcing ${pair} to CLOSE ${override.toUpperCase()} => ${completed.close.toFixed(6)}`);
                    candleOverride[pair] = null;
                }
                md.candles.push(completed);
                if (md.candles.length > 200) md.candles.shift();
                await Candle.updateOne({ asset: pair, timestamp: completed.timestamp }, { $set: completed }, { upsert: true });
            }
            md.currentCandle = { asset: pair, timestamp: currentMinuteStart, open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice };
        } else {
            // Update current candle's high/low/close
            md.currentCandle.high = Math.max(md.currentCandle.high, currentPrice);
            md.currentCandle.low = Math.min(md.currentCandle.low, currentPrice);
            md.currentCandle.close = currentPrice;
        }

        // Prepare data for broadcast
        const allCandles = [...md.candles, md.currentCandle];
        io.emit("market_data", { asset: pair, candles: allCandles, currentPrice: currentPrice });
        
        // Prepare dashboard/trading payloads (now happening inside the websocket handler)
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
    
    // Broadcast the collected price updates once per websocket event
    if (shouldBroadcast) {
        io.emit("price_update", payloadTrading);         
        io.emit("dashboard_price_update", payloadDashboard);
    }
}

// --------------------------------------------------------------------------------------------------
// ⭐ NEW FUNCTION: Start WebSocket Connection (Replaces 1-second REST polling)
// --------------------------------------------------------------------------------------------------
function startWebSocketStream() {
    console.log("📡 Starting Binance Futures Mini Ticker WebSocket Stream...");

    // The '!miniTicker@arr' stream provides fast, consolidated price updates for ALL pairs.
    binance.futuresSubscribe('!miniTicker@arr', (data) => {
        try {
            // data is an array of mini-ticker objects
            if (data && Array.isArray(data)) {
                processPriceUpdate(data);
            }
        } catch (error) {
            console.error('Error processing WebSocket data:', error);
        }
    });

    // Start 24h ticker update interval (this one still uses REST, but only once per minute)
    setInterval(fetchAndStore24hTicker, 60000); 
}


// ------------------ CANDLE / MARKET DATA LOGIC (FIXED) ------------------
async function initializeMarketData() {
    console.log("📈 Initializing market data from Binance...");
    
    // Fetch 24hr data once on startup
    await fetchAndStore24hTicker(); 
    
    for (const pair of TRADE_PAIRS) {
        try {
            // Use a delay to prevent rate-limiting during the initial historical data fetch
            await delay(500); 
            
            const klines = await binance.futuresCandles(pair, '1m', { limit: 200 });
            
            // Check for API failure (rate limit/malformed response)
            if (!Array.isArray(klines) || klines.length === 0) {
                 console.error(`❌ Failed to load initial candles for ${pair}: Received invalid or empty data from API (Likely Rate Limit).`);
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
            console.error(`❌ Failed to load initial candles for ${pair} (API/Network Error):`, (err && err.body) || err);
        }
    }
}

function startMarketData() {
    // ONLY WebSocket and the 24h ticker interval are now started here
    console.log("✅ Starting market data streaming and polling...");
    startWebSocketStream(); 
}

// ------------------ DB + STARTUP ------------------
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
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
    startMarketData(); // Start WebSocket streaming

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
