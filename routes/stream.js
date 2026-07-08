// ============================================================
// حفظ رابط البث - نسخة معدلة مع تحقق إضافي
// ============================================================
router.post('/save-link', authenticate, authorize(['teacher']), [
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('stream_url').notEmpty().withMessage('رابط البث مطلوب'),
    body('platform').isIn(['google-meet', 'microsoft-teams', 'other']).withMessage('منصة غير صالحة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log('❌ أخطاء في التحقق:', errors.array());
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, stream_url, platform } = req.body;

        console.log(`📥 [save-link] محاولة حفظ رابط البث:`);
        console.log(`   - offer_id: ${offer_id}`);
        console.log(`   - stream_url: ${stream_url}`);
        console.log(`   - platform: ${platform}`);
        console.log(`   - teacher_id: ${req.user.userId}`);

        // ✅ التحقق من وجود العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            console.log(`❌ العرض غير موجود: ${offer_id}`);
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        
        console.log(`✅ العرض موجود:`, {
            id: offer.id,
            subject: offer.subject_name,
            teacher_id: offer.teacher_id,
            current_status: offer.status
        });

        // ✅ التحقق
