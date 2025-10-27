// index.js - COMPLETE FIXED VERSION
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

// Market control override - IMPORTANT FOR ADMIN PANEL
const candleOverride = {};

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

// Admin routes with proper configuration
try {
    let adminRoutes;
    const hasAzureConfig = process.env.AZURE_STORAGE_ACCOUNT_NAME && process.env.AZURE_STORAGE_ACCOUNT_KEY;
    
    if (hasAzureConfig) {
        const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
        
        const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
        const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
        const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
        const blobServiceClient = new BlobServiceClient(
            `https://${accountName}.blob.core.windows.net`,
            sharedKeyCredential
        );
        
        adminRoutes = require("./routes/admin")({
            blobServiceClient,
            KYC_CONTAINER_NAME: process.env.KYC_CONTAINER_NAME || 'id-document-uploads',
            STORAGE_ACCOUNT_NAME: accountName,
            STORAGE_ACCOUNT_KEY: accountKey,
            azureEnabled: true,
            candleOverride: candleOverride
        });
        console.log('Admin routes loaded with Azure Storage');
    } else {
        console.log('Admin routes loaded without Azure Storage');
        adminRoutes = require("./routes/admin")({
            azureEnabled: false,
            candleOverride: candleOverride
        });
    }
    
    app.use("/api/admin", adminRoutes);
    console.log('Admin routes mounted');
} catch (error) {
    console.error('Admin routes failed to load:', error.message);
    const basicAdminRouter = require('express').Router();
    
    basicAdminRouter.get('/data', (req, res) => {
        res.status(200).json({ 
            success: true, 
            users: [], 
            tradeVolume: [], 
            marketStatus: {}, 
            tradePairs: TRADE_PAIRS,
            message: "Admin service in fallback mode" 
        });
    });
    
    basicAdminRouter.get('/kyc/pending-users', (req, res) => {
        res.json({ 
            success: true, 
            users: [],
            message: "KYC service temporarily unavailable" 
        });
    });
    
    basicAdminRouter.get('/market-control/status', (req, res) => {
        const status = {};
        TRADE_PAIRS.forEach(pair => {
            status[pair] = 'auto';
        });
        res.json({ success: true, marketStatus: status });
    });
    
    app.use("/api/admin", basicAdminRouter);
    console.log('Admin fallback routes loaded');
}

// KYC routes - FIXED VERSION
async function initializeKYCRoutes() {
    try {
        let kycRoutes;
        const hasAzureConfig = process.env.AZURE_STORAGE_ACCOUNT_NAME && process.env.AZURE_STORAGE_ACCOUNT_KEY;
        
        if (hasAzureConfig) {
            const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
            
            const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
            const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
            const KYC_CONTAINER_NAME = process.env.KYC_CONTAINER_NAME || 'id-document-uploads';
            
            const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
            const blobServiceClient = new BlobServiceClient(
                `https://${accountName}.blob.core.windows.net`,
                sharedKeyCredential
            );
            
            const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
            await containerClient.getProperties();
            
            kycRoutes = require("./routes/kyc")({
                blobServiceClient,
                KYC_CONTAINER_NAME: KYC_CONTAINER_NAME,
                azureEnabled: true
            });
            console.log('KYC routes loaded with Azure Storage');
        } else {
            console.log('KYC routes loaded without Azure Storage');
            kycRoutes = require("./routes/kyc")({
                azureEnabled: false
            });
        }
        
        app.use("/api/kyc", kycRoutes);
        console.log('KYC routes mounted');
    } catch (error) {
        console.error('KYC routes failed to load:', error.message);
        const basicKycRouter = require('express').Router();
        
        const userAuth = async (req, res, next) => {
            try {
                const authHeader = req.headers.authorization;
                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    return res.status(401).json({ success: false, message: 'Authentication required' });
                }
                
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                req.userId = decoded.id; 
                next();
            } catch (error) {
                return res.status(401).json({ success: false, message: 'Authentication failed' });
            }
        };
        
        // --- FIXED BLOCK: Returns success: true even on service failure to avoid client-side catch block ---
        basicKycRouter.get('/status', userAuth, async (req, res) => {
            try {
                const user = await User.findById(req.userId).select('kycStatus kycRejectionReason');
                res.json({ 
                    success: true, // IMPORTANT: Set to true to prevent client from showing "Service connection failed"
                    kycStatus: user?.kycStatus || 'pending',
                    rejectionReason: user?.kycRejectionReason,
                    serviceStatus: 'disabled',
                    message: 'KYC service unavailable'
                });
            } catch (error) {
                res.json({ 
                    success: true, // IMPORTANT: Set to true to prevent client from showing "Service connection failed"
                    kycStatus: 'pending',
                    serviceStatus: 'disabled',
                    message: 'KYC service unavailable due to user data fetch error'
                });
            }
        });
        // --- END FIXED BLOCK ---
        
        basicKycRouter.post('/upload', userAuth, (req, res) => {
            res.status(503).json({ 
                success: false, 
                message: 'KYC upload service temporarily unavailable. Please try again later.',
                serviceStatus: 'disabled'
            });
        });
        
        basicKycRouter.get('/service-status', userAuth, (req, res) => {
            res.json({
                success: true,
                serviceAvailable: false,
                status: 'KYC service connection failed',
                currentStatus: 'Service connection failed'
            });
        });
        
        app.use("/api/kyc", basicKycRouter);
        console.log('KYC fallback routes loaded');
    }
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
        console.log(`User disconnected: ${socket.id}`);
    });
});

// Initialize Market Data
async function initializeMarketData() {
    console.log("Initializing market data...");
    
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
                
                marketData[pair].currentCandle = {
                    asset: pair,
                    timestamp: getCurrentMinuteStart(),
                    open: lastCandle.close,
                    high: lastCandle.close,
                    low: lastCandle.close,
                    close: lastCandle.close
                };
                
                console.log(`Loaded ${marketData[pair].candles.length} candles for ${pair}`);
            }
        } catch (err) {
            console.error(`Error loading ${pair}:`, err.message);
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
        return;
    }
    
    console.log("Starting real-time market data stream...");
    
    const streams = TRADE_PAIRS.map(pair => `${pair.toLowerCase()}@trade`);
    
    try {
        binance.futuresSubscribe(streams, (trade) => {
            try {
                const pair = trade.s;
                const price = parseFloat(trade.p);
                const md = marketData[pair];
                
                if (!md) return;
                
                if (!isValidPrice(price, md.currentPrice)) return;
                
                md.currentPrice = price;
                
                const currentMinuteStart = getCurrentMinuteStart();
                
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
                    const completedCandle = { ...md.currentCandle };
                    completedCandle.close = price;
                    
                    if (completedCandle.open > 0) {
                        md.candles.push(completedCandle);
                        if (md.candles.length > 100) md.candles.shift();
                        
                        Candle.updateOne(
                            { asset: pair, timestamp: completedCandle.timestamp }, 
                            { $set: completedCandle }, 
                            { upsert: true }
                        ).catch(err => console.error(`DB save error for ${pair}:`, err.message));
                    }
                    
                    md.currentCandle = {
                        asset: pair,
                        timestamp: currentMinuteStart,
                        open: price,
                        high: price,
                        low: price,
                        close: price
                    };
                } else {
                    if (price > md.currentCandle.high) md.currentCandle.high = price;
                    if (price < md.currentCandle.low) md.currentCandle.low = price;
                    md.currentCandle.close = price;
                }

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
        console.log('WebSocket connected - Real-time data active');
        
    } catch (err) {
        console.error('WebSocket failed:', err.message);
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

// Database connection with retry logic
const connectWithRetry = () => {
    mongoose.connect(process.env.MONGO_URI, { 
        useNewUrlParser: true, 
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    }).then(() => {
        console.log('MongoDB connected successfully');
    }).catch(err => {
        console.error('MongoDB connection failed:', err.message);
        setTimeout(connectWithRetry, 5000);
    });
};

connectWithRetry();

// Initialize everything when database is ready
mongoose.connection.once("open", async () => {
    console.log("Database ready - Initializing application...");

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
        console.log(`Cleaned ${tradeUpdateResult.modifiedCount} corrupted trades`);
    } catch (error) {
        console.error("Cleanup warning:", error.message);
    }

    await initializeKYCRoutes();
    await initializeMarketData();
    startMarketDataStream();

    try {
        const tradeModule = require("./trade");
        if (typeof tradeModule.initialize === "function") {
            tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
            console.log("Trade module initialized");
        }
    } catch (error) {
        console.error("Trade module error:", error.message);
    }

    console.log("Application fully initialized and ready");
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        marketData: Object.keys(marketData).length > 0 ? 'active' : 'inactive'
    });
});

// Static file serving
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

// Global error handling
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        success: false, 
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
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
    console.error('Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});
