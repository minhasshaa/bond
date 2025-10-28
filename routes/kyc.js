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
module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME, azureEnabled = false }) {
    const router = express.Router();

    const CONTAINER_NAME = 'id-document-uploads';

    // Helper function to check Azure connection
    const checkAzureConnection = () => {
        if (!azureEnabled || !blobServiceClient) {
            throw new Error('KYC service connection failed. Azure Storage not configured.');
        }
    };

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/status - Fetch current KYC status (used on Profile load)
    // ----------------------------------------------------------------------
    router.get('/status', userAuth, async (req, res) => {
        try {
            // New: Also select permanent identity fields for client-side display check
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason kycFullName kycIdentityNumber'); 
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            
            // This is the clean response, which index.js will handle gracefully
            res.json({ 
                success: true, 
                kycStatus: user.kycStatus || 'pending', 
                rejectionReason: user.kycRejectionReason,
                kycFullName: user.kycFullName, // Send stored name
                kycIdentityNumber: user.kycIdentityNumber // Send stored ID
            });

        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch KYC status.' });
        }
    });

    // ----------------------------------------------------------------------
    // [POST] /api/kyc/identity - New Endpoint for Step 1: Submitting Name/ID
    // ----------------------------------------------------------------------
    router.post('/identity', userAuth, async (req, res) => {
        const { fullName, idNumber } = req.body;
        
        if (!fullName || !idNumber) {
            return res.status(400).json({ success: false, message: 'Full Name and ID Number are required.' });
        }

        try {
            // CRITICAL: Check for duplicate ID number
            const existingIdUser = await User.findOne({ 
                kycIdentityNumber: idNumber, 
                _id: { $ne: req.userId } 
            });
            
            if (existingIdUser) {
                 // FIX: Improved duplicate key error message
                 return res.status(400).json({ 
                    success: false, 
                    message: 'This Identity Number is already registered to another account.' 
                });
            }

            // Find and update the user's temporary identity fields
            const user = await User.findById(req.userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User record not found.' });
            }

            // Only save identity details and move to 'pending' verification stage
            user.kycFullName = fullName;
            user.kycIdentityNumber = idNumber;
            user.kycStatus = 'pending'; // Reset status to pending document upload
            user.kycRejectionReason = undefined;

            await user.save();

            res.json({ 
                success: true, 
                message: 'Identity confirmed. Please upload documents.',
                kycStatus: 'pending', // Indicate next step to client
            });

        } catch (error) {
             // Catch Mongoose unique constraint error if multiple users try the same ID simultaneously
            if (error.code === 11000) {
                 return res.status(400).json({ 
                    success: false, 
                    message: 'This Identity Number is already registered. Please contact support.' 
                });
            }
            console.error('KYC Identity Submission Error:', error);
            res.status(500).json({ success: false, message: 'Server error during identity submission.' });
        }
    });
    
    // ----------------------------------------------------------------------
    // [POST] /api/kyc/upload - Handle file upload and status update (MODIFIED)
    // ----------------------------------------------------------------------
    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 }, 
        { name: 'back', maxCount: 1 },
        { name: 'selfie', maxCount: 1 } // NEW: Added selfie field
    ]), async (req, res) => {
        let uploadStage = 'initializing';
        
        try {
            uploadStage = 'validation';
            
            // 1. Core Validation Checks
            if (!req.files || !req.files.front || !req.files.back || !req.files.selfie) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please provide ID front, ID back, and a selfie.' 
                });
            }

            // 2. Check Azure Connection
            uploadStage = 'azure_connection_check';
            if (!azureEnabled) {
                return res.status(503).json({ 
                    success: false, 
                    message: 'KYC upload service is currently unavailable.' 
                });
            }

            const userId = req.userId;
            const frontFile = req.files.front[0];
            const backFile = req.files.back[0];
            const selfieFile = req.files.selfie[0]; 

            // 3. Retrieve user to check identity status
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User record not found.' });
            }

            // New: Ensure identity step was completed
            if (!user.kycIdentityNumber || user.kycStatus === 'pending') {
                 return res.status(400).json({ 
                    success: false, 
                    message: 'Please complete the identity information step first.' 
                });
            }


            // 4. Create container and define secure blob paths
            uploadStage = 'azure_container_setup';
            const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
            await containerClient.createIfNotExists({ access: 'blob' });
            
            const frontBlobPath = `kyc-${userId}/front_${Date.now()}_${frontFile.originalname}`;
            const backBlobPath = `kyc-${userId}/back_${Date.now()}_${backFile.originalname}`;
            const selfieBlobPath = `kyc-${userId}/selfie_${Date.now()}_${selfieFile.originalname}`; 

            // 5. Upload All Files to Azure Blob Storage
            uploadStage = 'azure_upload';
            
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, { blobHTTPHeaders: { blobContentType: frontFile.mimetype } });
            
            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, { blobHTTPHeaders: { blobContentType: backFile.mimetype } });

            const selfieBlobClient = containerClient.getBlockBlobClient(selfieBlobPath); 
            await selfieBlobClient.uploadData(selfieFile.buffer, { blobHTTPHeaders: { blobContentType: selfieFile.mimetype } });

            uploadStage = 'database_update';

            // 6. Update User KYC Status and Save Blob Paths
            user.kycStatus = 'review';
            user.kycRejectionReason = undefined; 
            
            // Save all blob paths
            user.kycDocuments.front = frontBlobPath;
            user.kycDocuments.back = backBlobPath;
            user.kycSelfie = selfieBlobPath; // Save selfie path to the new field
            user.kycDocuments.uploadDate = new Date();
            
            await user.save();

            // 7. Send successful response
            res.json({ 
                success: true, 
                message: 'Documents and selfie uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'review', 
                serviceStatus: 'active'
            });

        } catch (error) {
            console.error('KYC Upload Error:', error);
            res.status(500).json({ 
                success: false, 
                message: `Failed to complete KYC submission: ${error.message}`
            });
        }
    });

    return router;
};
