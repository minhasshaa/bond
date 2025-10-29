const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    // Reference to the user involved in the conversation
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // Sender is either the 'user' or the 'admin'
    sender: {
        type: String,
        enum: ['user', 'admin'],
        required: true
    },
    text: {
        type: String,
        required: true
    },
    // Status flags for the Admin Panel to show "New" messages
    readByAdmin: {
        type: Boolean,
        default: false
    },
    // Status flag for the User Profile Panel
    readByUser: {
        type: Boolean,
        default: true // Assume user reads their own sent message instantly
    },
}, {
    timestamps: true // Creates 'createdAt' and 'updatedAt'
});

// ⭐ NEW: TTL Index definition for automatic deletion after 24 hours (86400 seconds)
const ONE_DAY_IN_SECONDS = 24 * 60 * 60; 
messageSchema.index({ "createdAt": 1 }, { expireAfterSeconds: ONE_DAY_IN_SECONDS });

module.exports = mongoose.model('Message', messageSchema);
