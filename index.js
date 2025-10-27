// index.js
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
        console.log("✅ Azure Blob Storage Client Initialized.");
        
        // Test the connection
        const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
        await containerClient.createIfNotExists({ access: 'blob' });
        console.log("✅ Azure Container verified/created successfully.");
    } catch (azureError) {
        console.error("❌ Azure Storage initialization failed:", azureError.message);
        azureEnabled = false;
    }
} else {
    console.warn("⚠️ WARNING: Azure Storage credentials not found. KYC upload will be disabled.");
    azureEnabled = false;
}
// >>> END AZURE CONFIGURATION <<<

// ------------------ MODELS & ROUTES ------------------
const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");
// >>> START KYC ADDITION <<<
const kycRoutes = require("./routes/kyc");
// >>> END KYC ADDITION <<<

// ------------------ APP + SERVER + IO ------------------
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const marketData = {};
TRADE_PAIRS.forEach(pair => {
  marketData[pair] = { 
    currentPrice: 0, 
    candles: [], 
    currentCandle: null,
    lastEmitTime: 0,
    lastPriceEmitTime: 0
  };
});
module.exports.marketData = marketData;
app.set('marketData', marketData);

// ------------------ BINANCE CLIENT ------------------
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET
});

// ------------------ MIDDLEWARE ------------------
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// ------------------ ROUTES ------------------
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/withdraw", withdrawRoutes);

// >>> START KYC ROUTE REGISTRATION <<<
// KYC Routes for user profile functionality
app.use("/api/kyc", kycRoutes({ 
    blobServiceClient, 
    KYC_CONTAINER_NAME, 
    azureEnabled: azureEnabled
}));
// >>> END KYC ROUTE REGISTRATION <<<

// Admin routes
app.use("/api/admin", adminRoutes({ 
    blobServiceClient, 
    KYC_CONTAINER_NAME, 
    STORAGE_ACCOUNT_NAME, 
    STORAGE_ACCOUNT_KEY,
    azureEnabled: azureEnabled,
    candleOverride: candleOverride 
}));

// ------------------ DASHBOARD DATA FUNCTIONS ------------------
async function getDashboardData(userId) {
    try {
        const user = await User.findById(userId).select('username balance email');
        if (!user) throw new Error('User not found');

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

            const lastCandle = data.candles[data.candles.length - 1] || data.currentCandle;
            if (!lastCandle || lastCandle.open === 0) {
                return { 
                    name: pair.replace('USDT', ''), 
                    ticker: `${pair.replace('USDT', '')}/USD`, 
                    price: data.currentPrice || 0, 
                    change: 0, 
                    candles: data.candles 
                };
            }

            const change = ((data.currentPrice - lastCandle.open) / lastCandle.open) * 100;

            return {
                name: pair.replace('USDT', ''),
                ticker: `${pair.replace('USDT', '')}/USD`,
                price: data.currentPrice,
                change: parseFloat(change.toFixed(2)),
                candles: data.candles
            };
        }).filter(Boolean);

        return {
            username: user.username,
            balance: user.balance,
            todayPnl: parseFloat(todayPnl.toFixed(2)),
            recentTrades: recentTrades.slice(0, 10),
            assets: marketInfo
        };
    } catch (error) {
        console.error('Dashboard data error:', error);
        throw error;
    }
}

// Socket Authentication
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Authentication error: No token"));
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded;
        next();
    } catch (ex) {
        return next(new Error("Authentication error: Invalid token"));
    }
});

// Socket.IO Connection Handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    if (socket.decoded && socket.decoded.id) {
        socket.join(socket.decoded.id);
        console.log(`User ${socket.decoded.id} joined their room`);
    }

    socket.on('request_dashboard_data', async () => {
        try {
            if (!socket.decoded || !socket.decoded.id) {
                return socket.emit('dashboard_data', { 
                    success: false, 
                    message: 'Authentication required' 
                });
            }

            const userId = socket.decoded.id;
            const dashboardData = await getDashboardData(userId);
            socket.emit('dashboard_data', { 
                success: true, 
                data: dashboardData 
            });
        } catch (error) {
            console.error('Dashboard data fetch error:', error);
            socket.emit('dashboard_data', { 
                success: false, 
                message: 'Could not fetch dashboard data' 
            });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`User disconnected: ${socket.id} - Reason: ${reason}`);
    });
});

// ------------------ MARKET DATA FUNCTIONS ------------------
function getCurrentMinuteStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 
                   now.getHours(), now.getMinutes(), 0, 0);
}

function isValidPrice(newPrice, previousPrice = 0) {
    if (!newPrice || newPrice <= 0 || !isFinite(newPrice)) return false;
    if (previousPrice > 0) {
        const changePercent = Math.abs((newPrice - previousPrice) / previousPrice) * 100;
        if (changePercent > 20) return false;
    }
    return true;
}

// Initialize Market Data
async function initializeMarketData() {
    console.log("📈 Initializing market data with 100 candles...");
    
    for (const pair of TRADE_PAIRS) {
        try {
            // Load 100 candles for good history
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
                
                // Start current candle
                marketData[pair].currentCandle = {
                    asset: pair,
                    timestamp: getCurrentMinuteStart(),
                    open: lastCandle.close,
                    high: lastCandle.close,
                    low: lastCandle.close,
                    close: lastCandle.close
                };
                
                console.log(`✅ Loaded ${marketData[pair].candles.length} candles for ${pair}`);
            }
        } catch (err) {
            console.error(`❌ Error loading ${pair}:`, err.message);
            // Set default values if loading fails
            marketData[pair].currentPrice = 100;
            marketData[pair].currentCandle = {
                asset: pair,
                timestamp: getCurrentMinuteStart(),
                open: 100,
                high: 100,
                low: 100,
                close: 100
            };
        }
    }
}

// Real-time Market Data Stream
let isStreaming = false;

function startMarketDataStream() {
    if (isStreaming) {
        console.log('⚠️ Market data stream already running');
        return;
    }
    
    console.log("⚡ Starting real-time market data stream...");
    
    const streams = TRADE_PAIRS.map(pair => `${pair.toLowerCase()}@trade`);
    
    try {
        binance.futuresSubscribe(streams, (trade) => {
            try {
                const pair = trade.s;
                const price = parseFloat(trade.p);
                const md = marketData[pair];
                
                if (!md) return;
                
                // Validate price
                if (!isValidPrice(price, md.currentPrice)) return;
                
                // Update current price
                md.currentPrice = price;
                
                const currentMinuteStart = getCurrentMinuteStart();
                
                // Initialize current candle if needed
                if (!md.currentCandle) {
                    md.currentCandle = {
                        asset: pair,
                        timestamp: currentMinuteStart,
                        open: price,
                        high: price,
                        low: price,
                        close: price
                    };
                }
                
                const isNewMinute = md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime();

                if (isNewMinute) {
                    // Complete previous candle
                    const completedCandle = { ...md.currentCandle };
                    completedCandle.close = price;
                    
                    // Add to history (keep last 100 candles)
                    if (completedCandle.open > 0) {
                        md.candles.push(completedCandle);
                        if (md.candles.length > 100) md.candles.shift();
                        
                        // Save to database async
                        Candle.updateOne(
                            { asset: pair, timestamp: completedCandle.timestamp }, 
                            { $set: completedCandle }, 
                            { upsert: true }
                        ).catch(err => console.error(`DB save error for ${pair}:`, err.message));
                    }
                    
                    // Start new candle
                    md.currentCandle = {
                        asset: pair,
                        timestamp: currentMinuteStart,
                        open: price,
                        high: price,
                        low: price,
                        close: price
                    };
                } else {
                    // Update current candle
                    if (price > md.currentCandle.high) md.currentCandle.high = price;
                    if (price < md.currentCandle.low) md.currentCandle.low = price;
                    md.currentCandle.close = price;
                }

                // Emit chart data (optimized - not every price change)
                const now = Date.now();
                if (now - md.lastEmitTime > 1000) {
                    md.lastEmitTime = now;
                    
                    const chartData = {
                        asset: pair, 
                        candles: [...md.candles],
                        currentCandle: md.currentCandle,
                        currentPrice: price,
                        timestamp: now,
                        isNewCandle: isNewMinute
                    };

                    io.emit("market_data", chartData);
                }
                
            } catch (err) {
                console.error(`Stream error for ${trade.s}:`, err.message);
            }
        });

        isStreaming = true;
        console.log('✅ WebSocket connected - Real-time data active');
        
    } catch (err) {
        console.error('❌ WebSocket failed:', err.message);
        setTimeout(startMarketDataStream, 10000);
    }
}

// Price Updates
setInterval(() => {
    const now = Date.now();
    const secondsUntilNextMinute = 60 - new Date().getSeconds();
    const priceData = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        if (md && md.currentPrice > 0) {
            if (now - md.lastPriceEmitTime > 500) {
                md.lastPriceEmitTime = now;
                
                priceData[pair] = {
                    price: md.currentPrice,
                    countdown: secondsUntilNextMinute,
                    timestamp: now
                };
            }
        }
    }
    
    if (Object.keys(priceData).length > 0) {
        io.emit("price_update", priceData);
    }
}, 100);

// ------------------ DATABASE CONNECTION ------------------
const connectWithRetry = () => {
    mongoose.connect(process.env.MONGO_URI, { 
        useNewUrlParser: true, 
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    }).then(() => {
        console.log('✅ MongoDB connected successfully');
    }).catch(err => {
        console.error('❌ MongoDB connection failed:', err.message);
        console.log('🔄 Retrying connection in 5 seconds...');
        setTimeout(connectWithRetry, 5000);
    });
};

connectWithRetry();

// Initialize everything when database is ready
mongoose.connection.once("open", async () => {
    console.log("✅ Database ready - Initializing application...");

    // Clean up corrupted trades
    try {
        const tradeUpdateResult = await Trade.updateMany(
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
        console.log(`🧹 Cleaned ${tradeUpdateResult.modifiedCount} corrupted trades`);
    } catch (error) {
        console.error("Cleanup warning:", error.message);
    }

    // Initialize market data and trading
    await initializeMarketData();
    startMarketDataStream();

    // Initialize trade module
    try {
        const tradeModule = require("./trade");
        if (typeof tradeModule.initialize === "function") {
            tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
            console.log("✅ Trade module initialized with all features");
        }
    } catch (error) {
        console.error("❌ Trade module error:", error.message);
    }

    console.log("🚀 Application fully initialized and ready");
});

// ------------------ ADDITIONAL ENDPOINTS ------------------
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        marketData: Object.keys(marketData).length > 0 ? 'active' : 'inactive',
        azureEnabled: azureEnabled
    });
});

// KYC Test endpoint
app.get('/api/kyc/test', async (req, res) => {
    try {
        if (!azureEnabled) {
            throw new Error('Azure Storage configuration missing');
        }

        const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
        await containerClient.getProperties();
        
        res.json({ 
            success: true, 
            message: 'KYC Azure Storage is working properly',
            azureStatus: 'connected',
            storage: 'azure'
        });
        
    } catch (error) {
        res.json({ 
            success: false, 
            message: 'KYC Azure Storage error: ' + error.message,
            azureStatus: 'error',
            storage: 'azure'
        });
    }
});

// Debug endpoint for Azure status
app.get('/api/debug/azure-status', (req, res) => {
    res.json({
        hasAzureConfig: !!STORAGE_ACCOUNT_NAME && !!STORAGE_ACCOUNT_KEY,
        azureEnabled: azureEnabled,
        hasKycContainer: !!KYC_CONTAINER_NAME,
        accountName: STORAGE_ACCOUNT_NAME ? 'set' : 'not set',
        accountKey: STORAGE_ACCOUNT_KEY ? 'set' : 'not set',
        kycContainer: KYC_CONTAINER_NAME,
        environment: process.env.NODE_ENV || 'development'
    });
});

// ------------------ STATIC FILE SERVING ------------------
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ 
            success: false, 
            message: 'API endpoint not found',
            path: req.path 
        });
    }
    
    res.sendFile(path.join(__dirname, 'public', req.path), (err) => {
        if (err) {
            res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
        }
    });
});

// ------------------ ERROR HANDLING ------------------
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        success: false, 
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔐 Admin key required: ${!!process.env.ADMIN_KEY}`);
    console.log(`📁 Azure Storage: ${azureEnabled ? '✅ Enabled' : '❌ Disabled'}`);
});

// ------------------ GRACEFUL SHUTDOWN ------------------
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('HTTP server closed');
        mongoose.connection.close(false, () => {
            console.log('MongoDB connection closed');
            process.exit(0);
        });
    });
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
});
