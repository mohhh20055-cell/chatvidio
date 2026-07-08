// ============================================================
// دوال رفع الملفات
// ============================================================

const { supabase } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateFileContent(buffer, mimeType) {
    const magicNumbers = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/gif': [0x47, 0x49, 0x46, 0x38],
        'image/webp': [0x52, 0x49, 0x46, 0x46],
        'application/pdf': [0x25, 0x50, 0x44, 0x46]
    };

    const expectedMagic = magicNumbers[mimeType];
    if (!expectedMagic) return false;

    for (let i = 0; i < expectedMagic.length && i < buffer.length; i++) {
        if (buffer[i] !== expectedMagic[i]) return false;
    }
    return true;
}

async function uploadToSupabase(file, folder, oldFileName = null) {
    try {
        if (!file || !file.buffer) return null;

        if (!validateFileContent(file.buffer, file.mimetype)) {
            throw new Error('الملف تالف أو غير صحيح');
        }

        const fileExt = path.extname(file.originalname);
        const fileName = `${uuidv4()}${fileExt}`;
        const filePath = `${folder}/${fileName}`;

        if (oldFileName) {
            try {
                const oldPath = `${folder}/${oldFileName}`;
                await supabase.storage.from('profiles').remove([oldPath]);
            } catch (e) {
                console.log('لم نتمكن من حذف الملف القديم');
            }
        }

        const { data, error } = await supabase.storage
            .from('profiles')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '86400'
            });

        if (error) {
            console.error('خطأ في رفع الصورة:', error);
            return null;
        }

        const { data: publicUrl } = supabase.storage
            .from('profiles')
            .getPublicUrl(filePath);

        return {
            filename: fileName,
            url: publicUrl.publicUrl
        };
    } catch (error) {
        console.error('خطأ:', error.message);
        return null;
    }
}

const validateUploadedFiles = (req, res, next) => {
    if (req.file && !validateFileContent(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ success: false, error: 'الملف تالف أو غير صحيح' });
    }
    
    if (req.files) {
        for (const field in req.files) {
            for (const file of req.files[field]) {
                if (!validateFileContent(file.buffer, file.mimetype)) {
                    return res.status(400).json({ success: false, error: `الملف ${file.originalname} تالف أو غير صحيح` });
                }
            }
        }
    }
    next();
};

module.exports = {
    uploadToSupabase,
    validateUploadedFiles,
    ALLOWED_MIME_TYPES,
    ALLOWED_EXTENSIONS,
    MAX_FILE_SIZE
};
