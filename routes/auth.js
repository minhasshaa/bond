const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto'); // Needed to generate random codes

// --- REGISTER A NEW USER ---
router.post('/register', async (req, res) => {
    try {
        // ✅ CHANGED: Added 'refCode' to the request body
        const { username, email, password, confirmPassword, region, refCode } = req.body;

        if (!username || !email || !password || !confirmPassword || !region) {  
            return res.status(400).json({ message: "All fields are required." });  
        }  
        if (password !== confirmPassword) {  
            return res.status(400).json({ message: "Passwords do not match." });  
        }  

        let referredBy = null;
        // If a referral code was provided, find the user who owns it
        if (refCode) {
            const referrer = await User.findOne({ referralCode: refCode });
            if (referrer) {
                referredBy = referrer._id;
            }
        }

        // Create a new user, including the referrer's ID if found
        const user = new User({ username, email, password, region, referredBy });  

        // ✅ NEW: Generate a unique referral code for the new user
        // This loop ensures the generated code is truly unique
        let isUnique = false;
        let referralCode = '';
        while (!isUnique) {
            referralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const existingUser = await User.findOne({ referralCode: referralCode });
            if (!existingUser) {
                isUnique = true;
            }
        }
        user.referralCode = referralCode;

        await user.save();  

        res.status(201).json({ message: "User registered successfully. Please log in." });

    } catch (error) {
        if (error.code === 11000) {
            if (error.keyPattern.username) {
                return res.status(409).json({ message: "Username already exists." });
            }
            if (error.keyPattern.email) {
                return res.status(409).json({ message: "Email is already registered." });
            }
        }
        console.error("Registration Error:", error);  
        res.status(500).json({ message: "Server error during registration." });
    }
});

// --- LOGIN A USER ---
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ message: "Username and password are required." });
        }

        const user = await User.findOne({ username });  
        if (!user || !(await user.comparePassword(password))) {  
            return res.status(401).json({ message: "Invalid credentials." });  
        }  

        const payload = { 
            id: user._id,
            username: user.username 
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ 
            message: "Logged in successfully.", 
            token,
            user: {
                id: user._id,
                username: user.username,
                balance: user.balance
            }
        });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Server error during login." });
    }
});

module.exports = router;