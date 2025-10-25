const mongoose = require('mongoose');

const candleSchema = new mongoose.Schema({
  asset: {
    type: String,
    required: true,
  },
  open: {
    type: Number,
    required: true,
  },
  high: {
    type: Number,
    required: true,
  },
  low: {
    type: Number,
    required: true,
  },
  close: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: Date,
    required: true,
    index: true,
    expires: 60 * 60 * 24 * 7 // ⏳ 7 days (in seconds)
  },
});

candleSchema.index({ asset: 1, timestamp: 1 }, { unique: true });

const Candle = mongoose.model('Candle', candleSchema);

module.exports = Candle;