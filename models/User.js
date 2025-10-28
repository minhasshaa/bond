const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// FIXED: Added all transaction types including admin operations
const transactionSchema = new mongoose.Schema({
    txid: { type: String, required: true },
    status: { type: String, default: 'pending_review' },
    date: { type: Date, default: Date.now },
    type: {
        type: String,
        enum: ['deposit', 'withdrawal', 'manual_credit', 'manual_debit', 'commission'],
        default: 'deposit'
    },
    amount: { type: Number },
    address: { type: String },
    tax: { type: Number, default: 0 },
    finalAmount: { type: Number },
    note: { type: String } // ADDED: For admin transaction notes
});

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    password: {
        type: String,
        required: true,
    },
    // START NEW VERIFICATION FIELDS
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        match: [/.+\@.+\..+/, 'Please fill a valid email address']
    },
    // ⭐ FIX: ADDED REGION FIELD
    region: { 
        type: String,
        required: true,
        enum: [
            'Africa', 
            'Asia', 
            'Europe', 
            'North America', 
            'South America', 
            'Oceania'
        ]
    },
    isVerified: {
        type: Boolean,
        default: false,
    },
    verificationCode: {
        type: String,
        default: null,
    },
    verificationCodeExpires: {
        type: Date,
        default: null,
    },
    // END NEW VERIFICATION FIELDS
    balance: {
        type: Number,
        default: 0.00,
    },
    depositAddress: {
        type: String,
        unique: true,
        sparse: true,
    },
    depositAddressIndex: {
        type: Number,
        default: null,
        sparse: true,
    },
    transactions: [transactionSchema],

    referralCode: {
        type: String,
        unique: true,
        sparse: true
    },
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    referralCommissions: {
        type: Number,
        default: 0
    },

    // ADDED: Fields for trading volume requirement
    totalDeposits: {
        type: Number,
        required: true,
        default: 0
    },
    totalTradeVolume: {
        type: Number,
        required: true,
        default: 0
    },

    // ADDED: KYC Identity Fields for anti-fraud
    fullName: {
        type: String,
        default: null,
        sparse: true,
        unique: true, // Enforce one account per name (will be combined with ID check)
    },
    identityNumber: {
        type: String,
        default: null,
        sparse: true,
        unique: true, // Enforce one account per ID number
    },
    
    // ADDED: KYC Verification Fields
    kycStatus: {
        type: String,
        enum: ['pending', 'review', 'verified', 'rejected'],
        default: 'pending'
    },
    kycDocuments: {
        front: { type: String }, // Store Azure blob path for front ID
        back: { type: String },  // Store Azure blob path for back ID
        selfie: { type: String }, // Store Azure blob path for selfie
        uploadDate: { type: Date }
    },
    kycRejectionReason: {
        type: String,
        default: null
    }

}, {
    timestamps: true
});

// Your original password hashing middleware (unchanged)
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Your original password comparison method (unchanged)
userSchema.methods.comparePassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
