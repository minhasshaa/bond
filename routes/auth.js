const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto'); // Needed to generate random codes
const bcrypt = require('bcryptjs'); // Needed for password hashing

// --- REGISTER A NEW USER ---
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, confirmPassword, region, refCode } = req.body;

        if (!username || !email || !password || !confirmPassword || !region) {  
            return res.status(400).json({ message: "All fields are required." });  
        }  
        if (password !== confirmPassword) {  
            return res.status(400).json({ message: "Passwords do not match." });
        }  

        let referredBy = null;
        // Referral tracking fix: checks for and finds the referrer
        if (refCode) {
            const referrer = await User.findOne({ referralCode: refCode });
            if (referrer) {
                referredBy = referrer._id;
            }
        }

        const user = new User({ username, email, password, region, referredBy });  

        // Generate and assign unique referral code
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

        // This save operation should now succeed due to the User model fix
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
        // Log the error for debugging but return a generic message to the user
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


// ----------------------------------------------------------------------
// NEW: PASSWORD RESET ROUTES (KYC Verification)
// ----------------------------------------------------------------------

// [POST] /api/auth/reset-password/verify-identity
router.post('/reset-password/verify-identity', async (req, res) => {
    const { username, fullName, identityNumber } = req.body;

    if (!username || !fullName || !identityNumber) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    try {
        const user = await User.findOne({ username });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Verification failed. Please check your credentials.' });
        }
        
        if (!user.fullName || !user.identityNumber) {
             return res.status(400).json({ success: false, message: 'KYC identity data is missing for this account. Please contact support.' });
        }

        const nameMatches = user.fullName.trim().toLowerCase() === fullName.trim().toLowerCase();
        const idMatches = user.identityNumber.trim().toLowerCase() === identityNumber.trim().toLowerCase();

        if (nameMatches && idMatches) {
            return res.json({ success: true, message: 'Identity verified. You can now set a new password.' });
        } else {
            return res.status(400).json({ success: false, message: 'Verification failed. Full Name or Identity Number do not match our records.' });
        }

    } catch (error) {
        console.error('Password Reset Identity Verification Error:', error);
        res.status(500).json({ success: false, message: 'A server error occurred during verification.' });
    }
});


// [POST] /api/auth/reset-password/update-password
router.post('/reset-password/update-password', async (req, res) => {
    const { username, newPassword } = req.body;

    if (!username || !newPassword) {
        return res.status(400).json({ success: false, message: 'Username and new password are required.' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    try {
        const user = await User.findOne({ username });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        
        user.password = newPassword; 

        await user.save();

        res.json({ success: true, message: 'Password updated successfully.' });

    } catch (error) {
        console.error('Password Update Error:', error);
        res.status(500).json({ success: false, message: 'A server error occurred while updating the password.' });
    }
});

module.exports = router;
