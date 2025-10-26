// index.js - COMPLETE FIXED VERSION WITH REAL-TIME CANDLES
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

// admin override flags
const candleOverride = {};
TRADE_PAIRS.forEach(pair => { candleOverride[pair] = null; });
module.exports.candleOverride = candleOverride;

// ------------------ MODELS & ROUTES ------------------
const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
let adminRoutes;

try {
    // Check if Azure storage is configured
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
        // Create admin routes without Azure support
        adminRoutes = require("./routes/admin")({});
        console.log('⚠️ Admin panel running without Azure Storage (KYC features disabled)');
    }
} catch (error) {
    console.log('⚠️ Azure Storage not available, admin KYC features disabled');
    // Fallback without Azure
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
    }
}); 

const marketData = {};
TRADE_PAIRS.forEach(pair => {
  marketData[pair] = { 
    currentPrice: 0, 
    historicalCandles: [],  // ⭐ CHANGED: Only completed candles
    activeCandle: null,     // ⭐ CHANGED: Renamed from currentCandle to activeCandle
    lastWebSocketUpdate: null,
    isWebSocketActive: false,
    lastEmitTime: 0
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

        const lastCandle = (Array.isArray(data.historicalCandles) && data.historicalCandles[data.historicalCandles.length - 1]) || data.activeCandle;
        if (!lastCandle || typeof lastCandle.open !== 'number' || lastCandle.open === 0) {
            return { name: pair.replace('USDT', ''), ticker: `${pair.replace('USDT', '')}/USD`, price: data.currentPrice || 0, change: 0, candles: data.historicalCandles };
        }

        const change = ((data.currentPrice - lastCandle.open) / lastCandle.open) * 100;

        return {
            name: pair.replace('USDT', ''),
            ticker: `${pair.replace('USDT', '')}/USD`,
            price: data.currentPrice,
            change: parseFloat(change.toFixed(2)),
            candles: data.historicalCandles
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

// ------------------ CANDLE / MARKET DATA LOGIC ------------------

async function initializeMarketData() {
    console.log("📈 Initializing market data from Binance...");
    for (const pair of TRADE_PAIRS) {
        try {
            const klines = await binance.futuresCandles(pair, '1m', { limit: 200 });
            
            if (!Array.isArray(klines) || klines.length < 5) { 
                 console.warn(`⚠️ Historical load failed for ${pair}. Starting clean.`);
                 marketData[pair].historicalCandles = []; 
                 marketData[pair].currentPrice = 0;
                 marketData[pair].activeCandle = null; 
                 continue; 
            }

            marketData[pair].historicalCandles = klines.map(k => ({
                asset: pair,
                timestamp: new Date(k[0]),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
            }));
            const lastCandle = marketData[pair].historicalCandles[marketData[pair].historicalCandles.length - 1];
            marketData[pair].currentPrice = lastCandle.close;
            
            // Start active candle with current price and current minute
            const currentMinuteStart = new Date();
            currentMinuteStart.setSeconds(0, 0);
            currentMinuteStart.setMilliseconds(0);
            
            marketData[pair].activeCandle = {
                asset: pair,
                timestamp: currentMinuteStart,
                open: lastCandle.close, // Start with last close price
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close,
                isActive: true // ⭐ NEW: Mark as active
            };
            console.log(`✅ Loaded ${marketData[pair].historicalCandles.length} historical candles for ${pair}.`);
        } catch (err) {
            console.error(`❌ Fatal error in initial load for ${pair}:`, err.message);
            marketData[pair].historicalCandles = []; 
            marketData[pair].currentPrice = 0;
            marketData[pair].activeCandle = null;
        }
    }
}

let isStreaming = false;
let restPollingInterval = null;

// ⭐ NEW: Get current minute start timestamp
function getCurrentMinuteStart() {
    const now = new Date();
    now.setSeconds(0, 0);
    return now;
}

// ⭐ NEW: Check if we should start a new candle
function shouldStartNewCandle(activeCandle) {
    if (!activeCandle) return true;
    
    const currentMinuteStart = getCurrentMinuteStart();
    return activeCandle.timestamp.getTime() !== currentMinuteStart.getTime();
}

// ⭐ FIXED: REST API Polling with PROPER real-time candle updates
function startRESTPolling() {
    if (isStreaming) return;
    isStreaming = true;
    
    console.log("🔄 Starting REST API polling with real-time candle updates...");
    
    // Clear existing interval if any
    if (restPollingInterval) {
        clearInterval(restPollingInterval);
    }
    
    restPollingInterval = setInterval(async () => {
        try {
            const prices = await binance.futuresPrices();
            const now = new Date();
            
            for (const pair of TRADE_PAIRS) {
                const price = parseFloat(prices[pair]);
                if (!price || !marketData[pair]) continue;
                
                const md = marketData[pair];
                md.currentPrice = price;
                
                const currentMinuteStart = getCurrentMinuteStart();
                
                // ⭐ CRITICAL FIX: Check if we need to start a new candle
                if (shouldStartNewCandle(md.activeCandle)) {
                    // If we have an active candle, complete it first
                    if (md.activeCandle) {
                        const completedCandle = { 
                            ...md.activeCandle, 
                            close: md.currentPrice,
                            isActive: false // Mark as completed
                        };
                        
                        // Handle candle override if any
                        const override = candleOverride[pair];
                        if (override) {
                            const openP = completedCandle.open;
                            const priceChange = openP * 0.00015 * (Math.random() + 0.5);
                            if (override === 'up') {
                                completedCandle.close = openP + priceChange;
                                completedCandle.high = Math.max(completedCandle.high, completedCandle.close);
                            } else {
                                completedCandle.close = openP - priceChange;
                                completedCandle.low = Math.min(completedCandle.low, completedCandle.close);
                            }
                            console.log(`🔴 OVERRIDE: Forcing ${pair} to CLOSE ${override.toUpperCase()} => ${completedCandle.close.toFixed(6)}`);
                            candleOverride[pair] = null;
                        }
                        
                        // Save completed candle to historical data
                        if (completedCandle.open > 0 && completedCandle.close > 0) {
                            md.historicalCandles.push(completedCandle);
                            if (md.historicalCandles.length > 200) md.historicalCandles.shift();
                            
                            // Save to database
                            Candle.updateOne({ asset: pair, timestamp: completedCandle.timestamp }, { $set: completedCandle }, { upsert: true }).catch(err => {
                                console.error(`DB Error saving completed candle for ${pair}:`, err.message);
                            });
                        }
                        
                        console.log(`✅ Completed candle for ${pair} at ${completedCandle.timestamp.toISOString()}`);
                    }
                    
                    // Start NEW active candle
                    md.activeCandle = {
                        asset: pair,
                        timestamp: new Date(currentMinuteStart),
                        open: price,
                        high: price,
                        low: price,
                        close: price,
                        isActive: true
                    };
                    
                    console.log(`🆕 Started new active candle for ${pair}`);
                } else {
                    // ⭐ CRITICAL FIX: Update ACTIVE candle in real-time
                    if (md.activeCandle) {
                        // Update high if current price is higher
                        if (price > md.activeCandle.high) {
                            md.activeCandle.high = price;
                        }
                        // Update low if current price is lower
                        if (price < md.activeCandle.low) {
                            md.activeCandle.low = price;
                        }
                        // Always update close to current price
                        md.activeCandle.close = price;
                    }
                }

                // ⭐ CRITICAL FIX: Emit data with PROPER structure
                // Only emit if we have data and enough time has passed (throttle emissions)
                if (Date.now() - md.lastEmitTime > 500) { // Emit max every 500ms
                    const chartData = {
                        asset: pair, 
                        historicalCandles: [...md.historicalCandles], // Only completed candles
                        activeCandle: md.activeCandle ? { ...md.activeCandle } : null, // Current forming candle
                        currentPrice: price,
                        timestamp: now.getTime(),
                        dataSource: 'rest',
                        isNewCandle: shouldStartNewCandle(md.activeCandle) // Flag for frontend
                    };

                    // Emit to all connected clients
                    io.emit("market_data", chartData);
                    md.lastEmitTime = Date.now();
                }
            }
            
        } catch (err) {
            console.error('❌ REST polling error:', err.message);
        }
    }, 1000); // ⭐ INCREASED: Poll every 1 second for better real-time updates
}

// ⭐ FIXED: WebSocket with PROPER real-time candle updates
function startMarketDataStream() {
    if (isStreaming) return;
    
    console.log("⚡ Attempting Binance WebSocket...");
    
    const connectionTimeout = setTimeout(() => {
        if (!isStreaming) {
            console.log("❌ WebSocket timeout after 30s, switching to REST polling");
            TRADE_PAIRS.forEach(pair => {
                marketData[pair].isWebSocketActive = false;
            });
            startRESTPolling();
        }
    }, 30000);
    
    const streams = TRADE_PAIRS.map(pair => `${pair.toLowerCase()}@trade`);
    
    try {
        binance.futuresSubscribe(streams, (trade) => {
            try {
                const pair = trade.s;
                const price = parseFloat(trade.p);
                const md = marketData[pair];
                
                if (!md) return;
                
                // Mark as WebSocket active and track last update
                md.isWebSocketActive = true;
                md.lastWebSocketUpdate = Date.now();
                md.currentPrice = price;
                
                const now = new Date();
                const currentMinuteStart = getCurrentMinuteStart();
                
                // ⭐ CRITICAL FIX: Check if we need to start a new candle
                if (shouldStartNewCandle(md.activeCandle)) {
                    // If we have an active candle, complete it first
                    if (md.activeCandle) {
                        const completedCandle = { 
                            ...md.activeCandle, 
                            close: price,
                            isActive: false
                        };
                        
                        const override = candleOverride[pair];
                        if (override) {
                            const openP = completedCandle.open;
                            const priceChange = openP * 0.00015 * (Math.random() + 0.5);
                            if (override === 'up') {
                                completedCandle.close = openP + priceChange;
                                completedCandle.high = Math.max(completedCandle.high, completedCandle.close);
                            } else {
                                completedCandle.close = openP - priceChange;
                                completedCandle.low = Math.min(completedCandle.low, completedCandle.close);
                            }
                            console.log(`🔴 OVERRIDE: Forcing ${pair} to CLOSE ${override.toUpperCase()} => ${completedCandle.close.toFixed(6)}`);
                            candleOverride[pair] = null;
                        }
                        
                        if (completedCandle.open > 0 && completedCandle.close > 0) {
                            md.historicalCandles.push(completedCandle);
                            if (md.historicalCandles.length > 200) md.historicalCandles.shift();
                            
                            Candle.updateOne({ asset: pair, timestamp: completedCandle.timestamp }, { $set: completedCandle }, { upsert: true }).catch(err => {
                                console.error(`DB Error saving completed candle for ${pair}:`, err.message);
                            });
                        }
                    }
                    
                    // Start NEW active candle
                    md.activeCandle = {
                        asset: pair,
                        timestamp: new Date(currentMinuteStart),
                        open: price,
                        high: price,
                        low: price,
                        close: price,
                        isActive: true
                    };
                } else {
                    // ⭐ CRITICAL FIX: Update ACTIVE candle in real-time
                    if (md.activeCandle) {
                        // Update high if current price is higher
                        if (price > md.activeCandle.high) {
                            md.activeCandle.high = price;
                        }
                        // Update low if current price is lower
                        if (price < md.activeCandle.low) {
                            md.activeCandle.low = price;
                        }
                        // Always update close to current price
                        md.activeCandle.close = price;
                    }
                }

                // ⭐ CRITICAL FIX: Emit WebSocket data with PROPER structure
                if (Date.now() - md.lastEmitTime > 100) { // Emit max every 100ms for WebSocket
                    const chartData = {
                        asset: pair, 
                        historicalCandles: [...md.historicalCandles],
                        activeCandle: md.activeCandle ? { ...md.activeCandle } : null,
                        currentPrice: price,
                        timestamp: now.getTime(),
                        dataSource: 'websocket',
                        isNewCandle: shouldStartNewCandle(md.activeCandle)
                    };

                    io.emit("market_data", chartData);
                    md.lastEmitTime = Date.now();
                }
                
            } catch (streamErr) {
                console.error(`❌ Stream processing error for ${trade.s}:`, streamErr.message);
            }
        }, {
            open: () => {
                clearTimeout(connectionTimeout);
                isStreaming = true;
                // Mark all pairs as using WebSocket
                TRADE_PAIRS.forEach(pair => {
                    marketData[pair].isWebSocketActive = true;
                    marketData[pair].lastWebSocketUpdate = Date.now();
                });
                console.log('✅ Binance WebSocket connected');
            },
            close: (reason) => {
                isStreaming = false;
                // Mark all pairs as not using WebSocket
                TRADE_PAIRS.forEach(pair => {
                    marketData[pair].isWebSocketActive = false;
                });
                console.warn(`⚠️ WebSocket closed: ${reason}. Switching to REST polling...`);
                startRESTPolling();
            },
            error: (err) => {
                clearTimeout(connectionTimeout);
                isStreaming = false;
                // Mark all pairs as not using WebSocket
                TRADE_PAIRS.forEach(pair => {
                    marketData[pair].isWebSocketActive = false;
                });
                console.error('❌ WebSocket Error:', err.message);
                console.log('🔄 Switching to REST polling...');
                startRESTPolling();
            }
        });
    } catch (err) {
        console.error('❌ WebSocket setup failed:', err.message);
        // Mark all pairs as not using WebSocket
        TRADE_PAIRS.forEach(pair => {
            marketData[pair].isWebSocketActive = false;
        });
        startRESTPolling();
    }
}

// ------------------ DASHBOARD PRICE EMITTER ------------------
setInterval(() => {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadDashboard = {};
    const payloadTrading = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        if (!md || md.currentPrice === 0) continue; 
        
        const lastCandle = (md.historicalCandles && md.historicalCandles.length > 0) ? md.historicalCandles[md.historicalCandles.length - 1] : md.activeCandle;
        let change = 0;
        if (lastCandle && lastCandle.open !== 0) {
            change = ((md.currentPrice - lastCandle.open) / lastCandle.open) * 100;
        }

        const tickerForClient = `${pair.replace('USDT', '')}/USD`;
        payloadDashboard[tickerForClient] = {
            price: md.currentPrice,
            change: parseFloat(change.toFixed(2)),
            countdown: secondsUntilNextMinute
        };

        payloadTrading[pair] = {
            price: md.currentPrice,
            countdown: secondsUntilNextMinute,
            timestamp: now.getTime()
        };
    }
    
    if (Object.keys(payloadTrading).length > 0) {
        io.emit("price_update", payloadTrading);           
        io.emit("dashboard_price_update", payloadDashboard);
    }
}, 1000);

// ------------------ DB + STARTUP ------------------
mongoose.connect(process.env.MONGO_URI, { 
    useNewUrlParser: true, 
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
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

    const userUpdateResult = await UserModel.updateMany(
      { $or: [{ createdAt: { $not: { $type: 9 } } }, { createdAt: { $exists: false } }, { createdAt: null }] },
      { $set: { createdAt: new Date() } }
    );
    console.log(`🧹 Safely fixed ${userUpdateResult.modifiedCount} corrupted user date records.`);

  } catch (error) {
    console.error("Warning: Pre-boot database cleanup failed:", error.message);
  }

  await initializeMarketData();
  startMarketDataStream(); // This will automatically fall back to REST polling if WebSocket fails

  const tradeModule = require("./trade");
  if (typeof tradeModule.initialize === "function") {
    const Trade = mongoose.model('Trade');
    const User = mongoose.model('User');
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
  const filePath = path.join(__dirname, 'public', req.path);
  if (req.path.includes('..')) return res.status(403).send('Forbidden');
  res.sendFile(filePath, (err) => {
    if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Server is running and listening on port ${PORT}`));
