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

    // Use the correct container name - id-document-uploads
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
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason kycDocuments');
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            
            // Check if Azure is properly configured for KYC functionality
            if (!azureEnabled) {
                return res.json({ 
                    success: true, 
                    kycStatus: user.kycStatus || 'pending',
                    rejectionReason: user.kycRejectionReason,
                    serviceStatus: 'disabled',
                    message: 'KYC service is currently unavailable'
                });
            }
            
            res.json({ 
                success: true, 
                kycStatus: user.kycStatus || 'pending',
                rejectionReason: user.kycRejectionReason,
                serviceStatus: 'active'
            });

        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ 
                success: false, 
                message: 'Failed to fetch KYC status.',
                serviceStatus: 'error'
            });
        }
    });

    // ----------------------------------------------------------------------
    // [POST] /api/kyc/upload - Handle file upload and status update
    // ----------------------------------------------------------------------
    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 }
    ]), async (req, res) => {
        let uploadStage = 'initializing';
        
        try {
            uploadStage = 'validation';
            console.log('=== KYC UPLOAD STARTED ===');
            
            // 1. Validation Checks
            if (!req.files) {
                console.error("❌ No files in request");
                return res.status(400).json({ 
                    success: false, 
                    message: 'No files received. Please select both front and back ID files.' 
                });
            }

            if (!req.files.front || !req.files.back) {
                console.error("❌ Missing required files");
                console.log("Files structure:", Object.keys(req.files));
                console.log("Front files:", req.files.front ? req.files.front.length : 0);
                console.log("Back files:", req.files.back ? req.files.back.length : 0);
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please select both front and back ID files.' 
                });
            }

            // 2. Check Azure Connection
            uploadStage = 'azure_connection_check';
            console.log('🔧 Checking Azure connection...');
            checkAzureConnection();

            const userId = req.userId;
            const frontFile = req.files.front[0];
            const backFile = req.files.back[0];

            // Debug logging
            console.log('✅ Files validation passed');
            console.log("👤 User ID:", userId);
            console.log("📁 Front file:", frontFile.originalname, frontFile.size, "bytes", frontFile.mimetype);
            console.log("📁 Back file:", backFile.originalname, backFile.size, "bytes", backFile.mimetype);
            console.log("📦 Container name:", CONTAINER_NAME);

            // 3. Create container if it doesn't exist
            uploadStage = 'azure_container_setup';
            console.log('📦 Setting up Azure container...');
            const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
            
            try {
                await containerClient.createIfNotExists({ access: 'blob' });
                console.log('✅ Azure container ready');
            } catch (containerError) {
                console.error('❌ Azure container error:', containerError.message);
                throw new Error('Failed to access Azure storage container: ' + containerError.message);
            }

            // 4. Define secure blob paths
            const frontBlobPath = `kyc-${userId}/front_${Date.now()}_${frontFile.originalname}`;
            const backBlobPath = `kyc-${userId}/back_${Date.now()}_${backFile.originalname}`;

            console.log('📤 Uploading files to Azure...');
            console.log("Front blob path:", frontBlobPath);
            console.log("Back blob path:", backBlobPath);

            // 5. Upload Files to Azure Blob Storage
            uploadStage = 'azure_front_upload';
            console.log('⬆️ Uploading front file...');
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });
            console.log('✅ Front file uploaded');
            
            uploadStage = 'azure_back_upload';
            console.log('⬆️ Uploading back file...');
            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });
            console.log('✅ Back file uploaded');

            uploadStage = 'database_update';
            console.log('💾 Updating user record in database...');

            // 6. Update User KYC Status in Database
            const user = await User.findById(userId);
            if (!user) {
                console.error('❌ User not found in database');
                return res.status(404).json({ 
                    success: false, 
                    message: 'User record not found.' 
                });
            }

            // ✅ FIXED: Use 'review' instead of 'under_review' to match User model enum
            user.kycStatus = 'review';
            user.kycDocuments = {
                front: frontBlobPath,
                back: backBlobPath,
                uploadDate: new Date()
            };
            user.kycRejectionReason = undefined; 

            await user.save();
            console.log('✅ User record updated successfully');

            console.log('🎉 KYC upload completed successfully for user:', userId);

            // 7. Send successful response
            res.json({ 
                success: true, 
                message: 'Documents uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'review', // ✅ FIXED: Use 'review' instead of 'under_review'
                serviceStatus: 'active'
            });

        } catch (error) {
            console.error('❌ KYC Upload Error at stage:', uploadStage);
            console.error('Error details:', error);
            console.error('Error stack:', error.stack);
            
            // Specific error handling
            if (error.message.includes('Azure Storage not configured')) {
                console.error('🔧 Azure configuration missing');
                return res.status(503).json({ 
                    success: false, 
                    message: 'KYC service is currently unavailable. Please try again later.',
                    serviceStatus: 'disabled',
                    currentStatus: 'Service connection failed'
                });
            }
            
            if (error.code === 'REQUEST_SEND_ERROR' || error.message.includes('ENOTFOUND')) {
                console.error('🌐 Network/Azure connection error');
                return res.status(503).json({ 
                    success: false, 
                    message: 'Cannot connect to storage service. Please check your internet connection and try again.',
                    serviceStatus: 'error'
                });
            }
            
            if (error.message.includes('ContainerNotFound')) {
                console.error('📦 Azure container not found');
                return res.status(503).json({ 
                    success: false, 
                    message: 'Storage container not available. Please contact support.',
                    serviceStatus: 'error'
                });
            }
            
            if (error.message.includes('Public access is not permitted')) {
                console.error('🔐 Azure public access disabled');
                return res.status(503).json({ 
                    success: false, 
                    message: 'Storage configuration issue. Please enable "Allow blob public access" in Azure Portal or contact support.',
                    serviceStatus: 'error',
                    solution: 'Go to Azure Portal → Storage Account → Configuration → Set "Allow blob public access" to Enabled'
                });
            }
            
            // Generic error response
            res.status(500).json({ 
                success: false, 
                message: `Failed to complete KYC submission: ${error.message}`,
                serviceStatus: 'error',
                debug: process.env.NODE_ENV === 'development' ? {
                    stage: uploadStage,
                    error: error.message
                } : undefined
            });
        }
    });

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/service-status - Check if KYC service is available
    // ----------------------------------------------------------------------
    router.get('/service-status', userAuth, async (req, res) => {
        try {
            if (!azureEnabled) {
                return res.json({
                    success: true,
                    serviceAvailable: false,
                    status: 'KYC service connection failed - Azure not configured',
                    currentStatus: 'Service connection failed'
                });
            }

            // Test Azure connection
            const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
            await containerClient.getProperties();
            
            res.json({
                success: true,
                serviceAvailable: true,
                status: 'KYC service is active and connected',
                currentStatus: 'Service connected'
            });

        } catch (error) {
            console.error('KYC Service Status Check Error:', error);
            res.json({
                success: true,
                serviceAvailable: false,
                status: 'KYC service connection failed - ' + error.message,
                currentStatus: 'Service connection failed'
            });
        }
    });

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/debug - Debug endpoint to check configuration
    // ----------------------------------------------------------------------
    router.get('/debug', userAuth, async (req, res) => {
        try {
            const config = {
                azureEnabled: azureEnabled,
                hasBlobService: !!blobServiceClient,
                containerName: CONTAINER_NAME,
                environment: process.env.NODE_ENV,
                hasAccountName: !!process.env.AZURE_STORAGE_ACCOUNT_NAME,
                hasAccountKey: !!process.env.AZURE_STORAGE_ACCOUNT_KEY
            };
            
            if (azureEnabled && blobServiceClient) {
                try {
                    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
                    const properties = await containerClient.getProperties();
                    config.containerExists = true;
                    config.containerAccess = properties.blobPublicAccess;
                } catch (containerError) {
                    config.containerError = containerError.message;
                    config.containerExists = false;
                }
            }
            
            res.json({
                success: true,
                config: config,
                message: 'KYC debug information'
            });
            
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Debug endpoint error: ' + error.message
            });
        }
    });

    return router;
};
