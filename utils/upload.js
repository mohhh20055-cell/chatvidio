const logger = require('./logger');
const sharp = require('sharp');
// ============================================================
// دوال رفع الملفات
// ============================================================

const { supabase } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip', 'application/x-zip-compressed', 'application/vnd.rar', 'application/x-rar-compressed',
    'text/plain'
];
const ALLOWED_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.txt'
];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit

function validateFileContent(buffer, mimeType) {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return false;
    }
    return true;
}

async function uploadToSupabase(file, folder, oldFileName = null) {
    try {
        if (!file || !file.buffer) return null;

        if (!validateFileContent(file.buffer, file.mimetype)) {
            throw new Error('الملف تالف أو غير صحيح');
        }

        let fileBuffer = file.buffer;
        let fileExt = path.extname(file.originalname);
        let mimeType = file.mimetype;

        if (mimeType && mimeType.startsWith('image/')) {
            try {
                fileBuffer = await sharp(fileBuffer)
                    .rotate()
                    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80, progressive: true, mozjpeg: true })
                    .toBuffer();
                fileExt = '.jpg';
                mimeType = 'image/jpeg';
            } catch (sharpErr) {
                logger.error('فشل ضغط الصورة باستخدام sharp:', sharpErr.message);
                throw new Error('تعذر ضغط الصورة قبل التخزين');
            }
        }

        const fileName = `${uuidv4()}${fileExt}`;
        const filePath = `${folder}/${fileName}`;
        
        const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY;

        let useLocalFallback = !supabaseUrl || !supabaseKey;

        if (!useLocalFallback) {
            if (oldFileName && !oldFileName.startsWith('http') && !oldFileName.startsWith('data:')) {
                try {
                    const oldPath = oldFileName.includes('/') ? oldFileName : `${folder}/${oldFileName}`;
                    await supabase.storage.from('profiles').remove([oldPath]);
                } catch (e) {
                    console.log('لم نتمكن من حذف الملف القديم');
                }
            }

            try {
                const { data, error } = await supabase.storage
                    .from('profiles')
                    .upload(filePath, fileBuffer, {
                        contentType: mimeType,
                        cacheControl: '86400'
                    });

                if (error) {
                    console.warn('خطأ في رفع الصورة إلى Supabase، سيتم استخدام التخزين المحلي:', error.message);
                    useLocalFallback = true;
                } else {
                    const { data: urlData } = supabase.storage
                        .from('profiles')
                        .getPublicUrl(filePath);

                    return {
                        filename: fileName,
                        url: urlData?.publicUrl || `/uploads/${filePath}`
                    };
                }
            } catch (e) {
                console.warn('استثناء أثناء الرفع إلى Supabase، سيتم استخدام التخزين المحلي:', e.message);
                useLocalFallback = true;
            }
        }

        if (useLocalFallback) {
            const uploadDir = path.join(__dirname, '../public/uploads', folder);
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            const localFilePath = path.join(uploadDir, fileName);
            fs.writeFileSync(localFilePath, fileBuffer);
            
            const publicUrl = `/uploads/${folder}/${fileName}`;
            return {
                filename: fileName,
                url: publicUrl
            };
        }
    } catch (error) {
        logger.error('خطأ:', error.message);
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

function getPublicImageUrl(bucketName, folder, fileName) {
    if (!fileName || fileName === 'null' || fileName === 'undefined' || fileName === 'NULL') {
        console.log(`[getPublicImageUrl LOG] Skipping invalid filename: "${fileName}" for bucket: ${bucketName}, folder: ${folder}`);
        return null;
    }
    if (typeof fileName === 'string') {
        if (fileName.startsWith('http://') || fileName.startsWith('https://') || fileName.startsWith('data:') || fileName.startsWith('/')) {
            if (fileName.endsWith('/null') || fileName.endsWith('/undefined')) {
                console.warn(`[getPublicImageUrl LOG] Warning: detected invalid trailing null/undefined in full URL: "${fileName}"`);
                return null;
            }
            console.log(`[getPublicImageUrl LOG] Using existing full URL: "${fileName}"`);
            return encodeURI(fileName);
        }
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    let fullPath = typeof fileName === 'string' && fileName.includes('/') ? fileName : `${folder}/${fileName}`;
    // إزالة أية تكرارات لاسم الـ bucket في بداية المسار
    if (fullPath.startsWith(`${bucketName}/`)) {
        fullPath = fullPath.substring(bucketName.length + 1);
    }

    let resolvedUrl;
    if (supabaseUrl) {
        resolvedUrl = `${supabaseUrl}/storage/v1/object/public/${bucketName}/${fullPath}`;
    } else {
        resolvedUrl = `/uploads/${fullPath}`;
    }
    resolvedUrl = encodeURI(resolvedUrl);
    console.log(`[getPublicImageUrl LOG] Resolved URL for ${bucketName}/${fullPath} => ${resolvedUrl}`);
    return resolvedUrl;
}

function processUserProfile(user, role) {
    if (!user) return user;
    
    // تأمين الصورة الشخصية
    const profile_image_url = user.profile_url || getPublicImageUrl('profiles', role === 'teacher' ? 'teachers' : 'students', user.profile_image);
    user.profile_image = profile_image_url;
    user.profile_image_url = profile_image_url;
    
    // تأمين الروابط الأخرى للأستاذ
    if (role === 'teacher') {
        const certificate_image_url = user.diploma_image ? getPublicImageUrl('profiles', 'diplomas', user.diploma_image) : null;
        const id_card_image_url = user.id_image ? getPublicImageUrl('profiles', 'ids', user.id_image) : null;
        user.diploma_image = certificate_image_url;
        user.id_image = id_card_image_url;
        user.certificate_image_url = certificate_image_url;
        user.id_card_image_url = id_card_image_url;
        user.is_certified = Boolean(user.is_certified === true || user.status === 'certified' || user.verification_status === 'verified');
        user.status = user.status === 'rejected' ? 'rejected' : 'approved';
    }
    
    return user;
}

/**
 * ✅ حذف ملف من سلة التخزين السحابي (Supabase) والتخزين المحلي
 * @param {string} folder المجلد (مثل 'diplomas', 'ids', 'teachers', 'students')
 * @param {string} fileRef مسار الملف أو اسمه أو رابطه الكامل
 */
async function deleteStorageFile(folder, fileRef) {
    if (!fileRef || typeof fileRef !== 'string') return;
    const cleanRef = fileRef.trim();
    if (!cleanRef || cleanRef === 'null' || cleanRef === 'undefined' || cleanRef === 'NULL') return;

    try {
        let storagePath = null;
        let fileName = null;

        if (cleanRef.startsWith('http://') || cleanRef.startsWith('https://')) {
            try {
                const urlObj = new URL(cleanRef);
                const pathname = urlObj.pathname;
                const match = pathname.match(/(diplomas|ids|teachers|students|thumbnails|posts)\/([^/?#]+)/);
                if (match) {
                    storagePath = `${match[1]}/${match[2]}`;
                    fileName = match[2];
                } else {
                    fileName = path.basename(pathname);
                    storagePath = `${folder}/${fileName}`;
                }
            } catch (urlErr) {
                fileName = path.basename(cleanRef);
                storagePath = `${folder}/${fileName}`;
            }
        } else if (cleanRef.startsWith('/uploads/')) {
            const stripped = cleanRef.replace(/^\/uploads\//, '');
            storagePath = stripped.includes('/') ? stripped : `${folder}/${stripped}`;
            fileName = path.basename(stripped);
        } else {
            storagePath = cleanRef.includes('/') ? cleanRef : `${folder}/${cleanRef}`;
            fileName = path.basename(cleanRef);
        }

        if (storagePath.startsWith('profiles/')) {
            storagePath = storagePath.substring('profiles/'.length);
        }

        // 1. حذف من Supabase Storage
        try {
            if (supabase && supabase.storage) {
                const { error: removeErr } = await supabase.storage.from('profiles').remove([storagePath]);
                if (!removeErr) {
                    console.log(`🔒 [DATA PRIVACY] Deleted Supabase storage file: profiles/${storagePath}`);
                }
            }
        } catch (sbErr) {
            console.warn(`⚠️ [DATA PRIVACY] Supabase storage deletion notice (${storagePath}):`, sbErr.message);
        }

        // 2. حذف من القرص المحلي إن وجد
        try {
            const localPaths = [
                path.join(__dirname, '../public/uploads', storagePath),
                path.join(__dirname, '../public/uploads', folder, fileName)
            ];
            for (const p of localPaths) {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    console.log(`🔒 [DATA PRIVACY] Deleted local storage file: ${p}`);
                }
            }
        } catch (fsErr) {
            console.warn(`⚠️ [DATA PRIVACY] Local storage file deletion notice:`, fsErr.message);
        }
    } catch (err) {
        console.warn(`⚠️ [DATA PRIVACY] Error during file deletion for ${fileRef}:`, err.message);
    }
}

/**
 * ✅ الحذف الفوري والنهائي لوثائق التحقق من الهوية والدبلومات للأستاذ
 * تطبيقاً لمقتضيات القانون رقم 18-07 المتعلق بحماية المعطيات ذات الطابع الشخصي
 * @param {object|number} teacherObjOrId كائن الأستاذ أو معرفه الرقمي
 */
async function deleteTeacherVerificationDocs(teacherObjOrId) {
    try {
        let teacher = teacherObjOrId;
        if (typeof teacherObjOrId === 'number' || typeof teacherObjOrId === 'string') {
            const { data } = await supabase.from('teachers').select('*').eq('id', teacherObjOrId).single();
            teacher = data;
        }

        if (!teacher) return;

        const teacherId = teacher.id;
        const diplomaRef = teacher.diploma_image || teacher.certificate_image;
        const idRef = teacher.id_image || teacher.id_card_image;

        console.log(`🔒 [DATA PRIVACY] Executing immediate permanent deletion of verification documents for teacher ID: ${teacherId}...`);

        // حذف الملفات الفعلية من وحدات التخزين
        if (diplomaRef) {
            await deleteStorageFile('diplomas', diplomaRef);
        }
        if (idRef) {
            await deleteStorageFile('ids', idRef);
        }

        // تصفير الحقول نهائياً في قاعدة البيانات
        try {
            await supabase
                .from('teachers')
                .update({
                    diploma_image: null,
                    certificate_image: null,
                    id_image: null,
                    id_card_image: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', teacherId);
            console.log(`✅ [DATA PRIVACY] Successfully wiped ID & Diploma records from database for teacher ID: ${teacherId}`);
        } catch (dbErr) {
            console.warn(`⚠️ [DATA PRIVACY] Retrying DB update without legacy fields:`, dbErr.message);
            await supabase
                .from('teachers')
                .update({
                    diploma_image: null,
                    id_image: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', teacherId);
        }
    } catch (error) {
        logger.error('❌ [DATA PRIVACY ERROR] Error purging teacher verification docs:', error.message);
    }
}

module.exports = {
    uploadToSupabase,
    validateUploadedFiles,
    getPublicImageUrl,
    processUserProfile,
    deleteStorageFile,
    deleteTeacherVerificationDocs,
    ALLOWED_MIME_TYPES,
    ALLOWED_EXTENSIONS,
    MAX_FILE_SIZE
};
