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

    // Check if Azure Storage is properly configured
    const isAzureConfigured = !!(blobServiceClient && KYC_CONTAINER_NAME);

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/status - Fetch current KYC status (used on Profile load)
    // ----------------------------------------------------------------------
    router.get('/status', userAuth, async (req, res) => {
        try {
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason kycDocuments');
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            
            res.json({ 
                success: true, 
                kycStatus: user.kycStatus || 'pending',
                rejectionReason: user.kycRejectionReason,
                azureConfigured: isAzureConfigured // Let frontend know if KYC is available
            });

        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch KYC status.' });
        }
    });

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/config - Check KYC service availability
    // ----------------------------------------------------------------------
    router.get('/config', userAuth, (req, res) => {
        res.json({
            success: true,
            azureConfigured: isAzureConfigured,
            maxFileSize: 5 * 1024 * 1024, // 5MB
            allowedTypes: ['image/jpeg', 'image/png', 'application/pdf'],
            serviceAvailable: isAzureConfigured
        });
    });

    // ----------------------------------------------------------------------
    // [POST] /api/kyc/upload - Handle file upload and status update
    // ----------------------------------------------------------------------
    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 }
    ]), async (req, res) => {
        // 1. Check if Azure is configured
        if (!isAzureConfigured) {
            return res.status(503).json({ 
                success: false, 
                message: 'KYC verification service is temporarily unavailable. Please try again later or contact support.' 
            });
        }

        // 2. Validation Checks
        if (!req.files || !req.files.front || !req.files.back) {
            console.error("KYC Upload Error: Missing files or field name mismatch.");
            return res.status(400).json({ success: false, message: 'Please select both front and back ID files.' });
        }

        const userId = req.userId;
        const frontFile = req.files.front[0];
        const backFile = req.files.back[0];
        
        // Define secure blob paths
        const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
        const frontBlobPath = `${userId}/front_${Date.now()}_${frontFile.originalname}`;
        const backBlobPath = `${userId}/back_${Date.now()}_${backFile.originalname}`;

        try {
            // 3. Upload Files to Azure Blob Storage
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });
            
            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });

            // 4. Update User KYC Status in Database
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

            // 5. Send successful response
            res.json({ 
                success: true, 
                message: 'Documents uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'review'
            });

        } catch (error) {
            console.error('KYC Upload/Save Error:', error);
            
            // Check if it's an Azure connection error
            if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
                return res.status(503).json({ 
                    success: false, 
                    message: 'KYC service connection failed. Please try again later.' 
                });
            }
            
            res.status(500).json({ 
                success: false, 
                message: 'Failed to complete KYC submission due to a server error.' 
            });
        }
    });

    return router;
};
