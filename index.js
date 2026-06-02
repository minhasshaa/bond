// index.js - BLAZING FAST LOAD VERSION
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

const TRADE_PAIRS = [
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
    'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];
module.exports.TRADE_PAIRS = TRADE_PAIRS;

const candleOverride = {};
TRADE_PAIRS.forEach(pair => { candleOverride[pair] = null; });
module.exports.candleOverride = candleOverride;

const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const KYC_CONTAINER_NAME = process.env.KYC_CONTAINER_NAME || 'id-document-uploads';

let blobServiceClient = null;
let azureEnabled = false;

if (STORAGE_ACCOUNT_NAME && STORAGE_ACCOUNT_KEY) {
    try {
        const sharedKeyCredential = new StorageSharedKeyCredential(STORAGE_ACCOUNT_NAME, STORAGE_ACCOUNT_KEY);
        blobServiceClient = new BlobServiceClient(`https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`, sharedKeyCredential);
        azureEnabled = true;
        console.log("✅ Azure Blob Storage Client Initialized.");
    } catch (e) {
        console.error("❌ Azure Client Initialization failed.", e.message);
    }
}

const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");
const kycRoutes = require("./routes/kyc");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const marketData = {};
TRADE_PAIRS.forEach(pair => {
    marketData[pair] = { currentPrice: 0, candles: [], currentCandle: null, last24hChange: 0 };
});

module.exports.marketData = marketData;
app.set('marketData', marketData);
global.last24hTickerDataShared = {};

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

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication Error: No token"));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded;
        next();
    } catch (ex) {
        return next(new Error("Authentication Error: Invalid token"));
    }
});

io.on('connection', (socket) => {
    if (socket.decoded && socket.decoded.id) {
        socket.join(socket.decoded.id);
    }

    socket.on('request_dashboard_data', async () => {
        try {
            const userId = socket.decoded.id;
            const freshUser = await User.findById(userId);
            if (!freshUser) return;

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const todayTrades = await Trade.find({ 
                userId: freshUser._id, 
                status: "closed", 
                closeTime: { $gte: today, $lt: tomorrow } 
            });

            const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

            const assetsInfo = [
                { ticker: 'BTC/USDT', name: 'Bitcoin' },
                { ticker: 'ETH/USDT', name: 'Ethereum' },
                { ticker: 'BNB/USDT', name: 'Binance Coin' },
                { ticker: 'SOL/USDT', name: 'Solana' },
                { ticker: 'XRP/USDT', name: 'Ripple' },
                { ticker: 'ADA/USDT', name: 'Cardano' },
                { ticker: 'DOGE/USDT', name: 'Dogecoin' },
                { ticker: 'AVAX/USDT', name: 'Avalanche' },
                { ticker: 'LINK/USDT', name: 'Chainlink' },
                { ticker: 'MATIC/USDT', name: 'Polygon' }
            ];

            const assets = assetsInfo.map(info => {
                const rawPair = info.ticker.replace('/', '');
                const price = marketData[rawPair]?.currentPrice || 0;
                const change = global.last24hTickerDataShared[rawPair] || marketData[rawPair]?.last24hChange || 0;
                return {
                    ticker: info.ticker,
                    name: info.name,
                    price: price,
                    change: change
                };
            });

            socket.emit('dashboard_data', {
                success: true,
                data: {
                    username: freshUser.username,
                    balance: freshUser.balance,
                    todayPnl: parseFloat(todayPnl.toFixed(2)),
                    assets: assets
                }
            });
        } catch (error) {
            console.error("Dashboard emission error:", error);
        }
    });
});

async function initializeMarketData() {
    console.log("📈 Initializing backend candle cache memory in BACKGROUND...");
    
    // 🚀 BLAZING FAST: Fetch all 10 pairs concurrently instead of one by one
    const fetchPromises = TRADE_PAIRS.map(async (pair) => {
        try {
            const response = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=100`);
            const klines = response.data;
            if (!Array.isArray(klines)) return;

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
        } catch (err) {
            // Silently ignore to not spam logs
        }
    });

    await Promise.all(fetchPromises);
    console.log("✅ Background memory load complete!");
}

mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));

db.once("open", async () => {
    console.log("✅ Connected to MongoDB Database");
    
    // 🚀 FIX: Removed the "await" keyword. Server ab kisi cheez ka intezar nahi karega, foran boot hoga!
    initializeMarketData(); 

    const tradeModule = require("./trade");
    if (typeof tradeModule.initialize === "function") {
        tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
    } else if (typeof tradeModule === "function") {
        tradeModule(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
    }
});

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API endpoint not found.' });
    if (req.path.includes('..')) return res.status(403).send('Forbidden');
    const filePath = path.join(__dirname, 'public', req.path);
    res.sendFile(filePath, (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Core Cluster active on port ${PORT}`));

const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;
if (KEEP_ALIVE_URL) {
    setInterval(async () => {
        try { await axios.get(KEEP_ALIVE_URL); } catch (err) {}
    }, 14 * 60 * 1000);
}
