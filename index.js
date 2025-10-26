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

// ------------------ CONFIG & CONSTANTS ------------------
const requiredEnvVars = ['MONGO_URI', 'JWT_SECRET'];
const optionalEnvVars = ['CLIENT_URL', 'PORT', 'AZURE_STORAGE_CONNECTION_STRING'];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

const TRADE_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];
module.exports.TRADE_PAIRS = TRADE_PAIRS;

// ------------------ MODELS & ROUTES ------------------
const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");

try {
    mongoose.model('User');
    mongoose.model('Trade');
    mongoose.model('Candle');
} catch (error) {
    // Models are already registered
}

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
let adminRoutes;

try {
    const hasAzureConfig = process.env.AZURE_STORAGE_CONNECTION_STRING || 
                          (process.env.STORAGE_ACCOUNT_NAME && process.env.STORAGE_ACCOUNT_KEY);
    
    if (hasAzureConfig) {
        const { BlobServiceClient } = require('@azure/storage-blob');
        const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        
        adminRoutes = require("./routes/admin")({
            blobServiceClient,
            KYC_CONTAINER_NAME: process.env.KYC_CONTAINER_NAME || 'kyc-documents',
            STORAGE_ACCOUNT_NAME: process.env.STORAGE_ACCOUNT_NAME,
            STORAGE_ACCOUNT_KEY: process.env.STORAGE_ACCOUNT_KEY
        });
        console.log('✅ Azure Storage configured for admin panel');
    } else {
        adminRoutes = require("./routes/admin")({});
        console.log('⚠️ Admin panel running without Azure Storage (KYC features disabled)');
    }
} catch (error) {
    console.log('⚠️ Azure Storage not available, admin KYC features disabled');
    adminRoutes = require("./routes/admin")({});
}
const withdrawRoutes = require("./routes/withdraw");

// ------------------ APP + SERVER + IO ------------------
const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: process.env.CLIENT_URL || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // ⭐ OPTIMIZATION: Reduce ping interval and timeout for better performance
    pingInterval: 10000,
    pingTimeout: 5000
}); 

// ⭐ OPTIMIZED: Simplified market data structure
const marketData = {};
const MAX_CANDLES = 100; // Reduced from 200 for better performance
TRADE_PAIRS.forEach(pair => {
  marketData[pair] = { 
    currentPrice: 0, 
    candles: [], 
    currentCandle: null,
    lastEmitTime: 0,
    lastPrice: 0
  };
});
module.exports.marketData = marketData;
app.set('marketData', marketData);

// ------------------ BINANCE CLIENT ------------------
const binance = new Binance().options({});

// ------------------ MIDDLEWARE ------------------
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);

// ------------------ OPTIMIZED CANDLE VALIDATION ------------------
function validateCandle(candle) {
    if (!candle || !candle.open || !candle.close || candle.open <= 0) {
        return candle;
    }
    
    const MAX_PERCENT_CHANGE = 0.02;
    const percentChange = Math.abs((candle.close - candle.open) / candle.open);
    
    if (percentChange > MAX_PERCENT_CHANGE) {
        const direction = candle.close > candle.open ? 1 : -1;
        const cappedClose = candle.open * (1 + direction * MAX_PERCENT_CHANGE);
        
        candle.close = cappedClose;
        candle.high = Math.max(candle.open, cappedClose, candle.high || candle.open);
        candle.low = Math.min(candle.open, cappedClose, candle.low || candle.open);
    }
    
    candle.high = Math.max(candle.open, candle.close, candle.high || candle.open);
    candle.low = Math.min(candle.open, candle.close, candle.low || candle.open);
    
    return candle;
}

// ----- DASHBOARD DATA FUNCTIONS -----
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

        const lastCandle = data.candles.length > 0 ? data.candles[data.candles.length - 1] : data.currentCandle;
        if (!lastCandle || typeof lastCandle.open !== 'number' || lastCandle.open === 0) {
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
            console.error('Socket error fetching dashboard data:', error.message);
            socket.emit('dashboard_data', { success: false, message: 'Could not fetch dashboard data.' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// ------------------ OPTIMIZED MARKET DATA LOGIC ------------------

async function initializeMarketData() {
    console.log("📈 Initializing market data from Binance...");
    for (const pair of TRADE_PAIRS) {
        try {
            const klines = await binance.futuresCandles(pair, '1m', { limit: MAX_CANDLES });
            
            if (!Array.isArray(klines) || klines.length < 5) { 
                 console.warn(`⚠️ Historical load failed for ${pair}. Starting clean.`);
                 marketData[pair].candles = []; 
                 marketData[pair].currentPrice = 0;
                 marketData[pair].currentCandle = null; 
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
            
            marketData[pair].currentCandle = {
                asset: pair,
                timestamp: new Date(lastCandle.timestamp.getTime() + 60000),
                open: lastCandle.close,
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close
            };
            
            console.log(`✅ Loaded ${marketData[pair].candles.length} historical candles for ${pair}.`);
        } catch (err) {
            console.error(`❌ Fatal error in initial load for ${pair}:`, err.message);
            marketData[pair].candles = []; 
            marketData[pair].currentPrice = 0;
            marketData[pair].currentCandle = null;
        }
    }
}

let isStreaming = false;
const EMIT_THROTTLE_MS = 500; // Emit updates max every 500ms per pair

// ⭐ OPTIMIZED: Throttled market data updates
function startMarketDataStream() {
    if (isStreaming) return;
    
    console.log("⚡ Starting optimized Binance WebSocket...");
    
    const connectionTimeout = setTimeout(() => {
        if (!isStreaming) {
            console.log("❌ WebSocket timeout, switching to REST polling");
            startRESTPolling();
        }
    }, 10000);
    
    const streams = TRADE_PAIRS.map(pair => `${pair.toLowerCase()}@trade`);
    
    try {
        binance.futuresSubscribe(streams, (trade) => {
            try {
                const pair = trade.s;
                const price = parseFloat(trade.p);
                const md = marketData[pair];
                
                if (!md) return;
                
                const now = Date.now();
                md.currentPrice = price;
                
                const currentMinuteStart = new Date();
                currentMinuteStart.setSeconds(0, 0);
                currentMinuteStart.setMilliseconds(0);

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
                    // Complete the current candle
                    let completed = { ...md.currentCandle, close: price };
                    completed = validateCandle(completed);
                    
                    if (completed.open > 0 && completed.close > 0) {
                        md.candles.push(completed);
                        if (md.candles.length > MAX_CANDLES) md.candles.shift();
                        
                        // Save to database (non-blocking)
                        Candle.updateOne({ asset: pair, timestamp: completed.timestamp }, { $set: completed }, { upsert: true })
                            .catch(err => console.error(`DB Error saving candle for ${pair}:`, err.message));
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
                    // Update current candle in real-time
                    md.currentCandle.high = Math.max(md.currentCandle.high, price);
                    md.currentCandle.low = Math.min(md.currentCandle.low, price);
                    md.currentCandle.close = price;
                }

                // ⭐ OPTIMIZATION: Throttle emissions to prevent flooding
                if (now - md.lastEmitTime > EMIT_THROTTLE_MS || Math.abs(price - md.lastPrice) / md.lastPrice > 0.001) {
                    const chartData = {
                        asset: pair, 
                        candles: md.candles,
                        currentCandle: md.currentCandle,
                        currentPrice: price,
                        timestamp: now,
                        isNewCandle: isNewMinute
                    };

                    io.emit("market_data", chartData);
                    md.lastEmitTime = now;
                    md.lastPrice = price;
                }
                
            } catch (streamErr) {
                console.error(`❌ Stream processing error for ${trade.s}:`, streamErr.message);
            }
        }, {
            open: () => {
                clearTimeout(connectionTimeout);
                isStreaming = true;
                console.log('✅ Binance WebSocket connected - Optimized streaming');
            },
            close: (reason) => {
                isStreaming = false;
                console.warn(`⚠️ WebSocket closed: ${reason}. Switching to REST polling...`);
                startRESTPolling();
            },
            error: (err) => {
                clearTimeout(connectionTimeout);
                isStreaming = false;
                console.error('❌ WebSocket Error:', err.message);
                startRESTPolling();
            }
        });
    } catch (err) {
        console.error('❌ WebSocket setup failed:', err.message);
        startRESTPolling();
    }
}

// ⭐ OPTIMIZED: REST polling with throttling
function startRESTPolling() {
    if (isStreaming) return;
    isStreaming = true;
    
    console.log("🔄 Starting optimized REST API polling...");
    
    const pollInterval = setInterval(async () => {
        try {
            const prices = await binance.futuresPrices();
            const now = Date.now();
            
            for (const pair of TRADE_PAIRS) {
                const price = parseFloat(prices[pair]);
                if (!price || !marketData[pair]) continue;
                
                const md = marketData[pair];
                
                // Skip if no significant price change and recently emitted
                if (now - md.lastEmitTime < EMIT_THROTTLE_MS && Math.abs(price - md.lastPrice) / (md.lastPrice || 1) < 0.001) {
                    continue;
                }
                
                md.currentPrice = price;
                
                const currentMinuteStart = new Date();
                currentMinuteStart.setSeconds(0, 0);
                currentMinuteStart.setMilliseconds(0);

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
                    let completed = { ...md.currentCandle, close: price };
                    completed = validateCandle(completed);
                    
                    if (completed.open > 0 && completed.close > 0) {
                        md.candles.push(completed);
                        if (md.candles.length > MAX_CANDLES) md.candles.shift();
                        
                        Candle.updateOne({ asset: pair, timestamp: completed.timestamp }, { $set: completed }, { upsert: true })
                            .catch(err => console.error(`DB Error saving candle for ${pair}:`, err.message));
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
                    md.currentCandle.high = Math.max(md.currentCandle.high, price);
                    md.currentCandle.low = Math.min(md.currentCandle.low, price);
                    md.currentCandle.close = price;
                }

                const chartData = {
                    asset: pair, 
                    candles: md.candles,
                    currentCandle: md.currentCandle,
                    currentPrice: price,
                    timestamp: now,
                    isNewCandle: isNewMinute
                };

                io.emit("market_data", chartData);
                md.lastEmitTime = now;
                md.lastPrice = price;
            }
            
        } catch (err) {
            console.error('❌ REST polling error:', err.message);
        }
    }, 2000);

    return () => {
        clearInterval(pollInterval);
        isStreaming = false;
        console.log('🔄 REST API polling stopped');
    };
}

// ------------------ OPTIMIZED PRICE EMITTER ------------------
setInterval(() => {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadTrading = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        if (!md || md.currentPrice === 0) continue; 
        
        payloadTrading[pair] = {
            price: md.currentPrice,
            countdown: secondsUntilNextMinute,
            timestamp: now.getTime()
        };
    }
    
    if (Object.keys(payloadTrading).length > 0) {
        io.emit("price_update", payloadTrading);
    }
}, 1000);

// ------------------ DB + STARTUP ------------------
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

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.on("disconnected", () => console.log("⚠️ MongoDB disconnected"));
db.on("reconnected", () => console.log("✅ MongoDB reconnected"));

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

  } catch (error) {
    console.error("Warning: Pre-boot database cleanup failed:", error.message);
  }

  await initializeMarketData();
  startMarketDataStream();

  // Initialize trade module
  try {
    const tradeModule = require("./trade");
    const User = mongoose.model('User');
    const Trade = mongoose.model('Trade');
    
    if (typeof tradeModule.initialize === "function") {
        tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS);
    }
  } catch (error) {
    console.error("❌ Error loading trade module:", error.message);
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

// Global error handling
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
