// index.js - COMPLETE VERSION WITH ALL FEATURES
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const Binance = require("node-binance-api");
const jwt = require('jsonwebtoken');

// Import models and routes
const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const withdrawRoutes = require("./routes/withdraw");

// Config
const TRADE_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: process.env.CLIENT_URL || "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Market Data Storage - 100 candles for good history
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

const binance = new Binance().options({});

// Middleware
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/withdraw", withdrawRoutes);

// Admin routes - CORRECTED VERSION
try {
    let adminRoutes;
    
    // Check if Azure config exists
    const hasAzureConfig = process.env.AZURE_STORAGE_CONNECTION_STRING && 
                          process.env.KYC_CONTAINER_NAME;
    
    if (hasAzureConfig) {
        const { BlobServiceClient } = require('@azure/storage-blob');
        const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        
        adminRoutes = require("./routes/admin")({
            blobServiceClient,
            KYC_CONTAINER_NAME: process.env.KYC_CONTAINER_NAME || 'kyc-documents'
        });
        console.log('✅ Admin routes loaded with Azure KYC support');
    } else {
        // Load without Azure config - KYC features will be disabled
        adminRoutes = require("./routes/admin")({});
        console.log('✅ Admin routes loaded (KYC features disabled)');
    }
    
    app.use("/api/admin", adminRoutes);
} catch (error) {
    console.log('❌ Admin routes disabled:', error.message);
}

// Utility Functions
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

// Dashboard Data
async function getDashboardData(userId) {
    const user = await User.findById(userId).select('username balance');
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
        recentTrades: [],
        assets: marketInfo
    };
}

// Socket Authentication
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error: No token"));
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded;
        next();
    } catch (ex) {
        return next(new Error("Authentication error: Invalid token"));
    }
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    if (socket.decoded && socket.decoded.id) {
        socket.join(socket.decoded.id);
    }

    socket.on('request_dashboard_data', async () => {
        try {
            const userId = socket.decoded.id;
            const dashboardData = await getDashboardData(userId);
            socket.emit('dashboard_data', { success: true, data: dashboardData });
        } catch (error) {
            socket.emit('dashboard_data', { success: false, message: 'Could not fetch dashboard data' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

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
        }
    }
}

// Real-time Market Data
let isStreaming = false;

function startMarketDataStream() {
    if (isStreaming) return;
    
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
                if (now - md.lastEmitTime > 1000) { // Emit max once per second
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
    }
}

// Price Updates (separate from candles for better performance)
setInterval(() => {
    const now = Date.now();
    const secondsUntilNextMinute = 60 - new Date().getSeconds();
    const priceData = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        if (md && md.currentPrice > 0) {
            // Only emit price if it's been at least 500ms since last emit
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
}, 100); // Check every 100ms

// Database connection
mongoose.connect(process.env.MONGO_URI, { 
    useNewUrlParser: true, 
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
}).then(() => {
    console.log('✅ MongoDB connected successfully');
}).catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
});

// Initialize everything
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

    // Initialize trade module with ALL features
    try {
        const tradeModule = require("./trade");
        if (typeof tradeModule.initialize === "function") {
            tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS);
            console.log("✅ Trade module initialized with all features");
        }
    } catch (error) {
        console.error("❌ Trade module error:", error.message);
    }
});

// Static file serving
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ message: 'API endpoint not found' });
    }
    res.sendFile(path.join(__dirname, 'public', req.path), (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// Error handling
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
