const express = require('express');
const multer = require('multer');
const User = require('../models/User');
const jwt = require('jsonwebtoken'); 

// Set up Multer for handling file uploads in memory
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // Max 5MB per file
});

// User authentication middleware
const userAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // This is the correct logic for the frontend's 'Authorization': `Bearer ${token}`
            return res.status(401).json({ success: false, message: 'Authentication required: Missing token.' });
        }
        
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.id; 
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Authentication failed: Invalid token.' });
    }
};


// The entire module is a function that accepts Azure dependencies
module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME }) {
    const router = express.Router();

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/status - Fetch current KYC status (used on Profile load)
    // ----------------------------------------------------------------------
    router.get('/status', userAuth, async (req, res) => {
        try {
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason');
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            
            res.json({ 
                success: true, 
                kycStatus: user.kycStatus || 'pending', // Default to 'pending'
                rejectionReason: user.kycRejectionReason 
            });

        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch KYC status.' });
        }
    });

    // ----------------------------------------------------------------------
    // [POST] /api/kyc/upload - Handle file upload and status update
    // ----------------------------------------------------------------------
    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 }, // <<< CORRECTED FIELD NAME TO MATCH profile.html
        { name: 'back', maxCount: 1 }  // <<< CORRECTED FIELD NAME TO MATCH profile.html
    ]), async (req, res) => {
        // 1. Validation Checks
        if (!req.files || !req.files.front || !req.files.back) { // Check corrected names
            console.error("KYC Upload Error: Missing files or field name mismatch.");
            return res.status(400).json({ success: false, message: 'Please select both front and back ID files.' });
        }
        if (!blobServiceClient || !KYC_CONTAINER_NAME) {
            return res.status(503).json({ success: false, message: 'KYC upload service is temporarily disabled.' });
        }

        const userId = req.userId;
        const frontFile = req.files.front[0]; // Use corrected name
        const backFile = req.files.back[0];   // Use corrected name
        
        // Define secure blob paths
        const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
        const frontBlobPath = `${userId}/front_${Date.now()}_${frontFile.originalname}`;
        const backBlobPath = `${userId}/back_${Date.now()}_${backFile.originalname}`;

        try {
            // 2. Upload Files to Azure Blob Storage
            
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });
            
            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });

            // 3. CRITICAL: Update User KYC Status in Database (Persistence Fix)
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User record not found.' });
            }

            user.kycStatus = 'review';
            user.kycDocuments = {
                front: frontBlobPath,
                back: backBlobPath,
                uploadDate: new Date()
            };
            user.kycRejectionReason = undefined; 

            await user.save();

            // 4. Send successful response
            res.json({ 
                success: true, 
                message: 'Documents uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'review'
            });

        } catch (error) {
            console.error('KYC Upload/Save Error:', error);
            res.status(500).json({ success: false, message: 'Failed to complete KYC submission due to a server error.' });
        }
    });

    return router;
};
