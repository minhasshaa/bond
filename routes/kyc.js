// routes/kyc.js - CORRECTED VERSION
const express = require('express');
const multer = require('multer');
const User = require('../models/User');
const jwt = require('jsonwebtoken');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

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

module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME, azureEnabled = false }) {
    const router = express.Router();

    router.get('/status', userAuth, async (req, res) => {
        try {
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason fullName identityNumber');
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            res.json({
                success: true,
                kycStatus: user.kycStatus || 'pending',
                rejectionReason: user.kycRejectionReason,
                identitySubmitted: !!(user.fullName && user.identityNumber)
            });
        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch KYC status.' });
        }
    });

    router.post('/verify-identity', userAuth, async (req, res) => {
        const { fullName, identityNumber } = req.body;

        if (!fullName || !identityNumber) {
            return res.status(400).json({ success: false, message: 'Full Name and Identity Number are required.' });
        }

        try {
            const existingUser = await User.findOne({
                $or: [
                    { identityNumber: identityNumber.trim() },
                    { fullName: fullName.trim() }
                ],
                _id: { $ne: req.userId }
            });

            if (existingUser) {
                return res.status(409).json({
                    success: false,
                    message: 'This identity (name or ID number) is already associated with another account.',
                    reason: 'already_exists'
                });
            }

            const user = await User.findById(req.userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User record not found.' });
            }

            user.fullName = fullName.trim();
            user.identityNumber = identityNumber.trim();
            await user.save();

            res.json({
                success: true,
                message: 'Identity confirmed. Proceed to document upload.',
                reason: 'new_identity'
            });

        } catch (error) {
            console.error('KYC Identity Verification Error:', error);
            if (error.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message: 'This name or ID number is already registered in the system.',
                    reason: 'already_exists_db'
                });
            }
            res.status(500).json({ success: false, message: 'Failed to complete identity verification due to a server error.' });
        }
    });

    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 },
        { name: 'selfie', maxCount: 1 }
    ]), async (req, res) => {

        if (!req.files || !req.files.front || !req.files.back || !req.files.selfie) {
            return res.status(400).json({ success: false, message: 'Please select ID front, ID back, and a selfie file.' });
        }

        if (!blobServiceClient || !KYC_CONTAINER_NAME || !azureEnabled) {
            return res.status(503).json({
                success: false,
                message: 'KYC upload service is temporarily disabled. Storage connection failed.'
            });
        }

        const userId = req.userId;
        const frontFile = req.files.front[0];
        const backFile = req.files.back[0];
        const selfieFile = req.files.selfie[0];

        // FIX: Pehle user check karo — Azure upload se pehle
        // Pehle wala code pehle files upload karta tha phir user dhundta tha
        // Agar user nahi milta tha toh files waste ho jaati theen
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User record not found.' });
        }

        if (!user.fullName || !user.identityNumber) {
            return res.status(400).json({ success: false, message: 'Please complete the Name and ID verification step first.' });
        }

        const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
        const frontBlobPath = `${userId}/front_${Date.now()}_${frontFile.originalname}`;
        const backBlobPath = `${userId}/back_${Date.now()}_${backFile.originalname}`;
        const selfieBlobPath = `${userId}/selfie_${Date.now()}_${selfieFile.originalname}`;

        try {
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });

            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });

            const selfieBlobClient = containerClient.getBlockBlobClient(selfieBlobPath);
            await selfieBlobClient.uploadData(selfieFile.buffer, {
                blobHTTPHeaders: { blobContentType: selfieFile.mimetype }
            });

            user.kycStatus = 'review';
            user.kycDocuments = {
                front: frontBlobPath,
                back: backBlobPath,
                selfie: selfieBlobPath,
                uploadDate: new Date()
            };
            user.kycRejectionReason = undefined;

            await user.save();

            res.json({
                success: true,
                message: 'Documents and Selfie uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'review'
            });

        } catch (error) {
            console.error('KYC Upload/Save Error:', error);
            res.status(500).json({ success: false, message: 'Failed to complete KYC submission due to a server error.' });
        }
    });

    return router;
};
