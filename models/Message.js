
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
    timestamps: true // Adds createdAt and updatedAt fields
});

module.exports = mongoose.model('Message', messageSchema);
