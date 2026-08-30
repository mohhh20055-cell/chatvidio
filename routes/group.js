const express = require('express');
const router = express.Router();
const { supabase, insert, getOne } = require('../utils/db');
const { authenticate, authorize } = require('../middleware/auth');
const { verifyToken } = require('../utils/jwt');
const { uploadToSupabase } = require('../utils/upload');
const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Middleware للتوثيق الاختياري (للضيوف والزوار)
function optionalAuth(req, res, next) {
    let authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.query.token) {
        token = req.query.token;
    }
    if (token && token !== 'guest_token') {
        try {
            const decoded = verifyToken(token);
            if (decoded) {
                req.user = decoded;
            }
        } catch (e) {}
    }
    next();
}

// جلب معلومات المجموعة العامة (متاح للجميع والزوار)
router.get('/:id/public', async (req, res) => {
    const groupId = req.params.id;
    try {
        const numericGroupId = parseInt(groupId, 10);
        const checkGroupId = isNaN(numericGroupId) ? groupId : numericGroupId;

        const { data: group, error } = await supabase
            .from('groups')
            .select('*')
            .eq('id', checkGroupId)
            .maybeSingle();

        if (error || !group) {
            return res.status(404).json({ error: 'المجموعة غير موجودة' });
        }

        let teacherInfo = null;
        if (group.teacher_id) {
            const { data: teacher } = await supabase
                .from('teachers')
                .select('id, full_name, profile_image, profile_url, specialization, phone')
                .eq('id', group.teacher_id)
                .maybeSingle();
            teacherInfo = teacher;
        }

        const { data: dbMembers } = await supabase
            .from('group_members')
            .select('student_id, is_blocked')
            .eq('group_id', checkGroupId);

        const activeMemberIds = new Set();
        (dbMembers || []).forEach(m => {
            if (!m.is_blocked && m.student_id) activeMemberIds.add(String(m.student_id));
        });

        res.json({
            id: group.id,
            name: group.name,
            image_url: group.image_url,
            teacher_id: group.teacher_id,
            teacher_name: teacherInfo?.full_name || 'الأستاذ',
            teacher_phone: '',
            teacher_avatar: teacherInfo?.profile_url || teacherInfo?.profile_image || '',
            teacher_specialization: teacherInfo?.specialization || '',
            members_count: activeMemberIds.size,
            created_at: group.created_at
        });
    } catch (err) {
        console.error('Error fetching public group:', err);
        res.status(500).json({ error: 'حدث خطأ أثناء جلب معلومات المجموعة' });
    }
});

// البحث عن المجموعات العامة واستكشافها
router.get('/search', optionalAuth, async (req, res) => {
    try {
        const queryStr = (req.query.q || '').trim();
        const currentUserId = req.user ? req.user.userId : null;

        let { data: groups, error } = await supabase
            .from('groups')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(60);

        if (error) throw error;
        if (!groups) groups = [];

        const teacherIds = [...new Set(groups.map(g => g.teacher_id).filter(Boolean))];
        let teachersMap = {};
        if (teacherIds.length > 0) {
            const { data: teachers } = await supabase
                .from('teachers')
                .select('id, full_name, profile_image, profile_url, specialization, phone')
                .in('id', teacherIds);
            if (teachers) {
                teachers.forEach(t => {
                    teachersMap[t.id] = {
                        name: t.full_name || 'أستاذ',
                        avatar: t.profile_url || t.profile_image || '',
                        specialization: t.specialization || '',
                        phone: t.phone || ''
                    };
                });
            }
        }

        const groupIds = groups.map(g => g.id);
        const groupMembersMap = {};
        let myMemberships = new Set();

        if (groupIds.length > 0) {
            const { data: members } = await supabase
                .from('group_members')
                .select('group_id, student_id, is_blocked')
                .in('group_id', groupIds);

            if (members) {
                members.forEach(m => {
                    const gIdStr = String(m.group_id);
                    if (!groupMembersMap[gIdStr]) groupMembersMap[gIdStr] = new Set();
                    if (!m.is_blocked && m.student_id) {
                        groupMembersMap[gIdStr].add(String(m.student_id));
                    }
                    if (currentUserId && String(m.student_id) === String(currentUserId) && !m.is_blocked) {
                        myMemberships.add(gIdStr);
                    }
                });
            }
        }

        let enriched = groups.map(g => {
            const gIdStr = String(g.id);
            const tInfo = teachersMap[g.teacher_id] || {};
            const isOwner = currentUserId && String(g.teacher_id) === String(currentUserId);
            const isMember = isOwner || myMemberships.has(gIdStr) || myMemberships.has(g.id);

            return {
                id: g.id,
                name: g.name,
                image_url: g.image_url || '',
                created_at: g.created_at,
                teacher_id: g.teacher_id,
                teacher_name: tInfo.name || 'أستاذ',
                teacher_phone: '',
                teacher_avatar: tInfo.avatar || '',
                teacher_specialization: tInfo.specialization || '',
                members_count: groupMembersMap[gIdStr] ? groupMembersMap[gIdStr].size : 0,
                is_owner: !!isOwner,
                is_member: !!isMember
            };
        });

        if (queryStr) {
            const qLower = queryStr.toLowerCase();
            enriched = enriched.filter(g => 
                (g.name && g.name.toLowerCase().includes(qLower)) ||
                (g.teacher_name && g.teacher_name.toLowerCase().includes(qLower)) ||
                (g.teacher_specialization && g.teacher_specialization.toLowerCase().includes(qLower))
            );
        }

        res.json(enriched);
    } catch (error) {
        console.error('Error searching groups:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء البحث عن المجموعات' });
    }
});

// إنشاء مجموعة (أستاذ فقط)
router.post('/', authenticate, authorize(['teacher']), upload.single('image_file'), async (req, res) => {
    const { name } = req.body;
    let image_url = req.body.image_url || null;
    const teacherId = req.user.userId;

    if (!name) return res.status(400).json({ error: 'اسم المجموعة مطلوب' });

    try {
        if (req.file) {
            const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
            if (uploadRes && uploadRes.url) {
                image_url = uploadRes.url;
            }
        }
        const group = await insert('groups', { name, image_url, teacher_id: teacherId });
        res.status(201).json(group);
    } catch (error) {
        console.error('Error creating group:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء إنشاء المجموعة' });
    }
});

// تعديل اسم وبيانات المجموعة (فقط مالك ومنشئ المجموعة)
const handleGroupUpdate = async (req, res) => {
    const groupId = req.params.id;
    const { name } = req.body;
    let image_url = req.body.image_url;
    const teacherId = req.user.userId;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'اسم المجموعة مطلوب ولا يمكن أن يكون فارغاً' });
    }

    try {
        const numericGroupId = parseInt(groupId, 10);
        const gId = isNaN(numericGroupId) ? groupId : numericGroupId;

        const { data: group, error: fetchErr } = await supabase
            .from('groups')
            .select('*')
            .eq('id', gId)
            .maybeSingle();

        if (fetchErr) throw fetchErr;

        if (!group) {
            return res.status(404).json({ error: 'المجموعة غير موجودة' });
        }

        if (String(group.teacher_id) !== String(teacherId)) {
            return res.status(403).json({ error: 'غير مصرح لك بتعديل هذه المجموعة! فقط منشئ ومالك المجموعة يملك هذه الصلاحية.' });
        }

        const updateData = {
            name: name.trim()
        };

        if (req.file) {
            const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
            if (uploadRes && uploadRes.url) {
                updateData.image_url = uploadRes.url;
            }
        } else if (image_url !== undefined && image_url !== null) {
            updateData.image_url = image_url;
        }

        const { data: updatedGroup, error: updateErr } = await supabase
            .from('groups')
            .update(updateData)
            .eq('id', gId)
            .select()
            .single();

        if (updateErr) throw updateErr;

        res.json({
            success: true,
            message: 'تم تحديث اسم وبيانات المجموعة بنجاح',
            group: updatedGroup || { ...group, ...updateData }
        });
    } catch (error) {
        console.error('Error updating group:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء تعديل المجموعة: ' + (error.message || '') });
    }
};

router.put('/:id', authenticate, authorize(['teacher']), upload.single('image_file'), handleGroupUpdate);
router.patch('/:id', authenticate, authorize(['teacher']), upload.single('image_file'), handleGroupUpdate);
router.post('/:id/update', authenticate, authorize(['teacher']), upload.single('image_file'), handleGroupUpdate);

// جلب مجموعات الأستاذ مع عدد الطلاب وآخر رسالة
router.get('/teacher', authenticate, authorize(['teacher']), async (req, res) => {
    const teacherId = req.user.userId;
    try {
        const { data: groups, error } = await supabase
            .from('groups')
            .select('*')
            .eq('teacher_id', teacherId)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        if (!groups || groups.length === 0) return res.json([]);

        // جلب عدد الأعضاء لكل مجموعة
        const groupIds = groups.map(g => g.id);
        const { data: members } = await supabase
            .from('group_members')
            .select('group_id, student_id, is_blocked')
            .in('group_id', groupIds);

        const groupMembersMap = {};
        groupIds.forEach(gid => {
            groupMembersMap[String(gid)] = new Set();
        });

        if (members) {
            members.forEach(m => {
                const gIdStr = String(m.group_id);
                if (groupMembersMap[gIdStr] && !m.is_blocked && m.student_id) {
                    groupMembersMap[gIdStr].add(String(m.student_id));
                }
            });
        }

        const latestMsgsMap = {};
        if (groupIds.length > 0) {
            const { data: latestMsgs } = await supabase
                .from('group_messages')
                .select('group_id, created_at')
                .in('group_id', groupIds)
                .order('created_at', { ascending: false });

            if (latestMsgs) {
                latestMsgs.forEach(m => {
                    if (!latestMsgsMap[m.group_id]) {
                        latestMsgsMap[m.group_id] = m.created_at;
                    }
                });
            }
        }

        const enriched = groups.map(g => ({
            ...g,
            is_owner: true,
            is_member: true,
            members_count: groupMembersMap[String(g.id)] ? groupMembersMap[String(g.id)].size : 0,
            latest_message_time: latestMsgsMap[g.id] || null
        }));

        res.json(enriched);
    } catch (error) {
        console.error('Error fetching teacher groups:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء جلب المجموعات للأستاذ' });
    }
});

// انضمام للمجموعة (للطلاب والأساتذة مباشرة في قاعدة البيانات)
router.post('/:id/join', authenticate, authorize(['student', 'teacher']), async (req, res) => {
    const groupId = req.params.id;
    const userId = req.user.userId;
    const role = req.user.role || 'student';

    if (!userId || userId === -1 || userId === '-1') {
        return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً للانضمام إلى المجموعة', require_login: true });
    }

    try {
        const numericGroupId = parseInt(groupId, 10);
        const checkGroupId = isNaN(numericGroupId) ? groupId : numericGroupId;
        const parsedUserId = isNaN(parseInt(userId, 10)) ? userId : parseInt(userId, 10);

        const { data: group, error: gErr } = await supabase
            .from('groups')
            .select('*')
            .eq('id', checkGroupId)
            .maybeSingle();

        if (gErr || !group) {
            return res.status(404).json({ error: 'المجموعة غير موجودة' });
        }

        if (String(group.teacher_id) === String(userId)) {
            return res.status(200).json({ message: 'أنت مالك هذه المجموعة بالفعل', is_owner: true, is_member: true });
        }

        // Check if already member in Supabase
        const { data: existing } = await supabase
            .from('group_members')
            .select('*')
            .eq('group_id', checkGroupId)
            .eq('student_id', parsedUserId)
            .maybeSingle();

        if (existing) {
            if (existing.is_blocked) {
                return res.status(403).json({ error: 'عذراً، لقد تم حظرك من هذه المجموعة ولا يمكنك الانضمام إليها.' });
            }
            return res.status(200).json({ message: 'أنت عضو بالفعل في هذه المجموعة', is_member: true });
        }

        // Insert into group_members
        const memberPayload = {
            group_id: checkGroupId,
            student_id: parsedUserId,
            is_blocked: false,
            user_type: role
        };

        let { error: insertErr } = await supabase
            .from('group_members')
            .insert(memberPayload);

        if (insertErr) {
            // If user_type column doesn't exist yet, retry without user_type
            if (insertErr.message && insertErr.message.includes('user_type')) {
                delete memberPayload.user_type;
                const retry = await supabase.from('group_members').insert(memberPayload);
                insertErr = retry.error;
            }
        }

        if (insertErr) {
            console.error('Error inserting into group_members:', insertErr);
            if (insertErr.code === '23503') { // Foreign key violation on student_id
                return res.status(400).json({ 
                    error: 'يرجى تنفيذ سكريبت SQL في Supabase لإزالة قيد المفتاح الأجنبي من جدول group_members لتمكين الأساتذة من الانضمام.',
                    sql_fix: 'ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_student_id_fkey; ALTER TABLE group_members ADD COLUMN IF NOT EXISTS user_type TEXT DEFAULT \'student\';'
                });
            }
            throw insertErr;
        }

        res.status(200).json({ message: 'تم الانضمام للمجموعة بنجاح', is_member: true, success: true });
    } catch (error) {
        console.error('Error joining group:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء الانضمام للمجموعة: ' + (error.message || '') });
    }
});

// جلب مجموعات الطالب (النشطة وغير المحظورة)
router.get('/student', authenticate, authorize(['student']), async (req, res) => {
    const studentId = req.user.userId;
    try {
        const { data, error } = await supabase
            .from('group_members')
            .select('group_id, is_blocked, groups(*)')
            .eq('student_id', studentId);
        
        if (error) throw error;
        
        const activeGroups = (data || [])
            .filter(m => !m.is_blocked && m.groups)
            .map(m => m.groups);

        const groupIds = activeGroups.map(g => g.id);
        const latestMsgsMap = {};
        if (groupIds.length > 0) {
            const { data: latestMsgs } = await supabase
                .from('group_messages')
                .select('group_id, created_at')
                .in('group_id', groupIds)
                .order('created_at', { ascending: false });

            if (latestMsgs) {
                latestMsgs.forEach(m => {
                    if (!latestMsgsMap[m.group_id]) {
                        latestMsgsMap[m.group_id] = m.created_at;
                    }
                });
            }
        }

        const enriched = activeGroups.map(g => ({
            ...g,
            latest_message_time: latestMsgsMap[g.id] || null
        }));
            
        res.json(enriched);
    } catch (error) {
        console.error('Error fetching student groups:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء جلب المجموعات' });
    }
});

// جلب رسائل المجموعة مع بيانات المرسل والتفاعلات من قاعدة البيانات مباشرة
router.get('/:id/messages', optionalAuth, async (req, res) => {
    const groupId = req.params.id;
    try {
        const numericGroupId = parseInt(groupId, 10);
        const checkGroupId = isNaN(numericGroupId) ? groupId : numericGroupId;

        const { data: messages, error } = await supabase
            .from('group_messages')
            .select('*')
            .eq('group_id', checkGroupId)
            .order('created_at', { ascending: true });
        
        if (error) throw error;
        if (!messages || messages.length === 0) {
            return res.json([]);
        }

        const teacherIds = [...new Set(messages.filter(m => m.sender_type === 'teacher').map(m => m.sender_id))];
        const studentIds = [...new Set(messages.filter(m => m.sender_type === 'student').map(m => m.sender_id))];

        let teachersMap = {};
        let studentsMap = {};

        if (teacherIds.length > 0) {
            const { data: teachers } = await supabase
                .from('teachers')
                .select('id, full_name, profile_url, profile_image')
                .in('id', teacherIds);
            if (teachers) {
                teachers.forEach(t => {
                    teachersMap[t.id] = {
                        name: t.full_name,
                        avatar: t.profile_url || t.profile_image || ''
                    };
                });
            }
        }

        if (studentIds.length > 0) {
            const { data: students } = await supabase
                .from('students')
                .select('id, full_name, profile_image, profile_url')
                .in('id', studentIds);
            if (students) {
                students.forEach(s => {
                    studentsMap[s.id] = {
                        name: s.full_name,
                        avatar: s.profile_url || s.profile_image || ''
                    };
                });
            }
        }

        const enrichedMessages = messages.map(m => {
            let senderName = 'مستخدم';
            let senderAvatar = '';
            if (m.sender_type === 'teacher') {
                senderName = (teachersMap[m.sender_id] && teachersMap[m.sender_id].name) || 'أستاذ';
                senderAvatar = (teachersMap[m.sender_id] && teachersMap[m.sender_id].avatar) || '';
            } else if (m.sender_type === 'student') {
                senderName = (studentsMap[m.sender_id] && studentsMap[m.sender_id].name) || 'طالب';
                senderAvatar = (studentsMap[m.sender_id] && studentsMap[m.sender_id].avatar) || '';
            }

            let msgReactions = m.reactions;
            if (typeof msgReactions === 'string') {
                try { msgReactions = JSON.parse(msgReactions); } catch(e) { msgReactions = {}; }
            } else if (typeof msgReactions !== 'object' || msgReactions === null) {
                msgReactions = {};
            }

            let file_url = m.file_url || null;
            let file_name = m.file_name || null;
            let file_size = m.file_size || null;
            let file_type = m.file_type || null;
            let reply_to_id = m.reply_to_id || null;
            let reply_to_text = m.reply_to_text || null;
            let reply_to_sender = m.reply_to_sender || null;
            let displayMessage = m.message || '';

            // استخراج المرفق إذا كان مدمجاً في الرسالة
            const attachmentMatch = displayMessage.match(/<!--ATTACHMENT:([\s\S]*?)-->/);
            if (attachmentMatch) {
                try {
                    const parsedAtt = JSON.parse(attachmentMatch[1]);
                    if (parsedAtt.file_url) file_url = parsedAtt.file_url;
                    if (parsedAtt.file_name) file_name = parsedAtt.file_name;
                    if (parsedAtt.file_size) file_size = parsedAtt.file_size;
                    if (parsedAtt.file_type) file_type = parsedAtt.file_type;
                } catch(e) {}
                displayMessage = displayMessage.replace(/<!--ATTACHMENT:[\s\S]*?-->/, '').trim();
            }

            // استخراج الرد إذا كان مدمجاً في الرسالة
            const replyMatch = displayMessage.match(/<!--REPLY:([\s\S]*?)-->/);
            if (replyMatch) {
                try {
                    const parsedReply = JSON.parse(replyMatch[1]);
                    if (parsedReply.reply_to_id) reply_to_id = parsedReply.reply_to_id;
                    if (parsedReply.reply_to_text) reply_to_text = parsedReply.reply_to_text;
                    if (parsedReply.reply_to_sender) reply_to_sender = parsedReply.reply_to_sender;
                } catch(e) {}
                displayMessage = displayMessage.replace(/<!--REPLY:[\s\S]*?-->/, '').trim();
            }

            return {
                ...m,
                message: displayMessage,
                file_url,
                file_name,
                file_size,
                file_type,
                sender_name: senderName,
                sender_avatar: senderAvatar,
                reactions: msgReactions,
                reply_to_id,
                reply_to_text,
                reply_to_sender
            };
        });

        res.json(enrichedMessages);
    } catch (error) {
        console.error('Error fetching group messages:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء جلب الرسائل' });
    }
});

// رفع ملف PDF أو مرفق للمجموعة
router.post('/:id/upload-file', authenticate, upload.single('file'), async (req, res) => {
    const groupId = req.params.id;
    const userId = req.user.userId;
    const role = req.user.role;

    if (!userId || userId === -1 || userId === '-1') {
        return res.status(401).json({ error: 'يجب تسجيل الدخول لرفع الملفات', require_login: true });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'يرجى اختيار ملف لرفعه' });
    }

    try {
        const numericGroupId = parseInt(groupId, 10);
        const checkGroupId = isNaN(numericGroupId) ? groupId : numericGroupId;
        const parsedUserId = isNaN(parseInt(userId, 10)) ? userId : parseInt(userId, 10);

        // التحقق من صلاحية المستخدم في المجموعة
        if (role === 'student') {
            const { data: membership } = await supabase
                .from('group_members')
                .select('*')
                .eq('group_id', checkGroupId)
                .eq('student_id', parsedUserId)
                .maybeSingle();

            if (!membership) {
                return res.status(403).json({ error: 'يجب الانضمام للمجموعة أولاً لتتمكن من مشاركة الملفات' });
            }
            if (membership.is_blocked) {
                return res.status(403).json({ error: 'عذراً، لقد تم حظرك من النشر في هذه المجموعة' });
            }
        }

        // التحقق من نوع الملف (صور، مستندات، PDF)
        const mime = req.file.mimetype || '';
        const ext = (req.file.originalname || '').toLowerCase();
        const isImage = mime.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg)$/.test(ext);
        const isPdf = mime.includes('pdf') || ext.endsWith('.pdf');
        const isDoc = /\.(doc|docx|xls|xlsx|ppt|pptx|zip|rar|txt)$/.test(ext);

        if (!isImage && !isPdf && !isDoc) {
            return res.status(400).json({ error: 'نوع الملف غير مدعوم، يرجى رفع صورة أو ملف PDF أو مستند صالح' });
        }

        // حد أقصى 25MB لحجم الملف
        if (req.file.size > 25 * 1024 * 1024) {
            return res.status(400).json({ error: 'حجم الملف كبير جداً، الحد الأقصى المسموح به هو 25 ميغابايت' });
        }

        const uploadResult = await uploadToSupabase(req.file, 'groups');
        if (!uploadResult || !uploadResult.url) {
            return res.status(500).json({ error: 'فشل حفظ الملف على الخادم، يرجى المحاولة لاحقاً' });
        }

        const calculatedType = isImage ? 'image' : (isPdf ? 'application/pdf' : 'document');

        res.json({
            success: true,
            file_url: uploadResult.url,
            file_name: req.file.originalname,
            file_size: req.file.size,
            file_type: calculatedType
        });
    } catch (error) {
        console.error('Error uploading file to group:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء رفع الملف' });
    }
});

// إرسال رسالة للمجموعة (أستاذ أو طالب نشط) مع دعم ملفات PDF المرفقة
router.post('/:id/messages', authenticate, upload.single('file'), async (req, res) => {
    const groupId = req.params.id;
    let { message, file_url, file_name, file_size, file_type, reply_to_id, reply_to_text, reply_to_sender } = req.body || {};
    const userId = req.user.userId;
    const role = req.user.role; // 'teacher' or 'student'

    if (!userId || userId === -1 || userId === '-1') {
        return res.status(401).json({ error: 'يجب تسجيل الدخول كطالب أو كأستاذ للمشاركة وإرسال الرسائل في المجموعة', require_login: true });
    }

    try {
        const numericGroupId = parseInt(groupId, 10);
        const checkGroupId = isNaN(numericGroupId) ? groupId : numericGroupId;
        const parsedUserId = isNaN(parseInt(userId, 10)) ? userId : parseInt(userId, 10);

        // إذا تم إرفاق ملف مباشرة مع الرسالة
        if (req.file) {
            const uploadResult = await uploadToSupabase(req.file, 'groups');
            if (uploadResult && uploadResult.url) {
                file_url = uploadResult.url;
                file_name = req.file.originalname;
                file_size = req.file.size;
                file_type = 'application/pdf';
            }
        }

        const cleanMessage = (message || '').trim();
        if (!cleanMessage && !file_url) {
            return res.status(400).json({ error: 'نص الرسالة أو ملف المرفق مطلوب' });
        }

        let senderName = '';
        let senderAvatar = '';

        const { data: group, error: gErr } = await supabase
            .from('groups')
            .select('*')
            .eq('id', checkGroupId)
            .maybeSingle();

        if (gErr || !group) {
            return res.status(404).json({ error: 'المجموعة غير موجودة' });
        }

        // التحقق من الصلاحية
        if (role === 'teacher') {
            const isOwner = String(group.teacher_id) === String(userId);
            
            if (!isOwner) {
                const { data: membership } = await supabase
                    .from('group_members')
                    .select('*')
                    .eq('group_id', checkGroupId)
                    .eq('student_id', parsedUserId)
                    .maybeSingle();

                if (!membership) {
                    return res.status(403).json({ error: 'يجب الانضمام للمجموعة أولاً لتتمكن من النشر فيها' });
                }
                if (membership.is_blocked) {
                    return res.status(403).json({ error: 'عذراً، لقد تم حظرك من النشر في هذه المجموعة' });
                }
            }

            const { data: teacher } = await supabase
                .from('teachers')
                .select('full_name, profile_image, profile_url')
                .eq('id', parsedUserId)
                .maybeSingle();
            if (teacher) {
                senderName = teacher.full_name;
                senderAvatar = teacher.profile_url || teacher.profile_image || '';
            }
        } else if (role === 'student') {
            // التأكد من أن الطالب عضو نشط وغير محظور
            const { data: membership } = await supabase
                .from('group_members')
                .select('*')
                .eq('group_id', checkGroupId)
                .eq('student_id', parsedUserId)
                .maybeSingle();

            if (!membership) {
                return res.status(403).json({ error: 'يجب الانضمام للمجموعة أولاً لتتمكن من النشر' });
            }
            if (membership.is_blocked) {
                return res.status(403).json({ error: 'عذراً، لقد تم حظرك من النشر في هذه المجموعة' });
            }

            const { data: student } = await supabase
                .from('students')
                .select('full_name, profile_image, profile_url')
                .eq('id', parsedUserId)
                .maybeSingle();
            if (student) {
                senderName = student.full_name;
                senderAvatar = student.profile_url || student.profile_image || '';
            }
        } else {
            return res.status(403).json({ error: 'غير مصرح' });
        }

        let inserted = null;
        let insertErr = null;

        const baseMsgData = { 
            group_id: checkGroupId, 
            sender_id: parsedUserId, 
            sender_type: role
        };

        // محاولة أولى: إدراج مع الحقول مباشرة
        try {
            const { data, error } = await supabase
                .from('group_messages')
                .insert({
                    ...baseMsgData,
                    message: cleanMessage,
                    ...(file_url ? {
                        file_url: file_url,
                        file_name: file_name || 'ملف PDF',
                        file_size: file_size || null,
                        file_type: file_type || 'application/pdf'
                    } : {}),
                    ...(reply_to_id ? {
                        reply_to_id: parseInt(reply_to_id, 10),
                        reply_to_text: String(reply_to_text || '').slice(0, 300),
                        reply_to_sender: String(reply_to_sender || '').slice(0, 100)
                    } : {})
                })
                .select()
                .single();
            if (!error && data) {
                inserted = data;
            } else {
                insertErr = error;
            }
        } catch(e) {
            insertErr = e;
        }

        // محاولة بديلة: إدراج مع ترميز المرفقات والردود داخل نص الرسالة في حال عدم وجود الأعمدة
        if (!inserted) {
            let combinedMessage = cleanMessage;
            if (reply_to_id) {
                combinedMessage = `${combinedMessage}\n<!--REPLY:${JSON.stringify({ reply_to_id: parseInt(reply_to_id, 10), reply_to_sender: String(reply_to_sender || '').slice(0, 100), reply_to_text: String(reply_to_text || '').slice(0, 300) })}-->`;
            }
            if (file_url) {
                combinedMessage = `${combinedMessage}\n<!--ATTACHMENT:${JSON.stringify({ file_url, file_name: file_name || 'ملف PDF', file_size, file_type: file_type || 'application/pdf' })}-->`;
            }

            const { data, error } = await supabase
                .from('group_messages')
                .insert({
                    ...baseMsgData,
                    message: combinedMessage.trim()
                })
                .select()
                .single();

            if (error) throw error;
            inserted = data;
        }

        res.status(201).json({
            ...inserted,
            message: cleanMessage,
            file_url: file_url || null,
            file_name: file_name || null,
            file_size: file_size || null,
            file_type: file_type || null,
            sender_name: senderName || (role === 'teacher' ? 'الأستاذ' : 'طالب'),
            sender_avatar: senderAvatar,
            reactions: {},
            reply_to_id: reply_to_id ? parseInt(reply_to_id, 10) : null,
            reply_to_text: reply_to_text || null,
            reply_to_sender: reply_to_sender || null
        });
    } catch (error) {
        console.error('Error posting message to group:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء إرسال الرسالة' });
    }
});

// حذف رسالة في المجموعة (صاحب/مالك المجموعة أو صاحب الرسالة فقط)
router.delete('/:groupId/messages/:messageId', authenticate, async (req, res) => {
    const { groupId, messageId } = req.params;
    const userId = req.user.userId;
    const role = req.user.role;

    try {
        const numericGroupId = parseInt(groupId, 10);
        const checkGroupId = isNaN(numericGroupId) ? groupId : numericGroupId;

        // التحقق من مالك المجموعة
        const { data: group } = await supabase
            .from('groups')
            .select('*')
            .eq('id', checkGroupId)
            .maybeSingle();

        const numericMsgId = parseInt(messageId, 10);
        const checkMsgId = isNaN(numericMsgId) ? messageId : numericMsgId;

        const { data: msg } = await supabase
            .from('group_messages')
            .select('*')
            .eq('id', checkMsgId)
            .maybeSingle();

        if (!msg) {
            return res.status(404).json({ error: 'الرسالة غير موجودة' });
        }

        const isGroupOwner = group && role === 'teacher' && String(group.teacher_id) === String(userId);
        const isMsgSender = String(msg.sender_id) === String(userId) && msg.sender_type === role;

        if (!isGroupOwner && !isMsgSender) {
            return res.status(403).json({ error: 'غير مصرح لك بحذف هذه الرسالة! يحق فقط لصاحب الرسالة أو مالك المجموعة حذفها.' });
        }

        const { error } = await supabase
            .from('group_messages')
            .delete()
            .eq('id', checkMsgId);

        if (error) throw error;

        res.json({ success: true, message: 'تم حذف الرسالة بنجاح', messageId: checkMsgId });
    } catch (error) {
        console.error('Error deleting group message:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء حذف الرسالة' });
    }
});

// التفاعل مع رسالة في المجموعة بإيموجي (مباشرة في قاعدة البيانات)
router.post('/:groupId/messages/:messageId/react', authenticate, async (req, res) => {
    const { groupId, messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user.userId;
    const role = req.user.role;

    if (!emoji) {
        return res.status(400).json({ error: 'رمز التفاعل مطلوب' });
    }

    try {
        const numericMsgId = parseInt(messageId, 10);
        const checkMsgId = isNaN(numericMsgId) ? messageId : numericMsgId;

        const { data: msg, error: msgErr } = await supabase
            .from('group_messages')
            .select('*')
            .eq('id', checkMsgId)
            .maybeSingle();

        if (msgErr || !msg) {
            return res.status(404).json({ error: 'الرسالة غير موجودة' });
        }

        let currentReactions = msg.reactions || {};
        if (typeof currentReactions === 'string') {
            try { currentReactions = JSON.parse(currentReactions); } catch(e) { currentReactions = {}; }
        } else if (typeof currentReactions !== 'object' || currentReactions === null) {
            currentReactions = {};
        }

        const userKey = `${role}_${userId}`;
        if (currentReactions[userKey] === emoji) {
            delete currentReactions[userKey];
        } else {
            currentReactions[userKey] = emoji;
        }

        const { error: updateErr } = await supabase
            .from('group_messages')
            .update({ reactions: currentReactions })
            .eq('id', checkMsgId);

        if (updateErr) {
            console.warn('Could not update reactions column in Supabase:', updateErr.message);
        }

        res.json({ success: true, reactions: currentReactions, messageId: checkMsgId });
    } catch (error) {
        console.error('Error reacting to message:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء التفاعل مع الرسالة' });
    }
});

// جلب أعضاء المجموعة (للأستاذ لإدارتهم أو للطلاب والزملاء لعرضهم مباشرة من قاعدة البيانات)
router.get('/:id/members', optionalAuth, async (req, res) => {
    const groupId = req.params.id;
    const numericGroupId = parseInt(groupId, 10);
    const checkGroupId = isNaN(numericGroupId) ? groupId : numericGroupId;

    try {
        let { data: group, error: gErr } = await supabase
            .from('groups')
            .select('*')
            .eq('id', checkGroupId)
            .maybeSingle();

        if (!group) return res.status(404).json({ error: 'المجموعة غير موجودة' });

        // 1. جلب الأعضاء من جدول group_members في Supabase (بشكل مرن بدون فرض ترتيب بالـ database لتجنب مشاكل غياب العمود)
        const { data: members, error: mErr } = await supabase
            .from('group_members')
            .select('*')
            .eq('group_id', checkGroupId);

        if (mErr) {
            console.error('Error querying group_members:', mErr);
        }

        const membersList = members || [];
        // ترتيب العناصر برمجياً بالـ JavaScript ليكون كودنا مرناً وسليماً دائماً
        membersList.sort((a, b) => {
            const dateA = a.created_at || a.joined_at || '';
            const dateB = b.created_at || b.joined_at || '';
            return dateB.localeCompare(dateA);
        });

        const rawMemberIds = membersList.map(m => m.student_id || m.user_id).filter(Boolean);
        if (group.teacher_id) {
            rawMemberIds.push(group.teacher_id);
        }

        const uniqueIds = [...new Set(rawMemberIds)].filter(Boolean);
        if (uniqueIds.length === 0) {
            return res.json([]);
        }

        const numericIds = uniqueIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
        const stringIds = uniqueIds.map(id => String(id));

        let students = [];
        let teachers = [];

        if (numericIds.length > 0) {
            const { data: s1 } = await supabase
                .from('students')
                .select('id, full_name, profile_image, profile_url, phone')
                .in('id', numericIds);
            if (s1) students.push(...s1);

            const { data: t1 } = await supabase
                .from('teachers')
                .select('id, full_name, profile_image, profile_url, phone')
                .in('id', numericIds);
            if (t1) teachers.push(...t1);
        }

        if (stringIds.length > 0) {
            const { data: s2 } = await supabase
                .from('students')
                .select('id, full_name, profile_image, profile_url, phone')
                .in('id', stringIds);
            if (s2) {
                s2.forEach(item => {
                    if (!students.some(x => String(x.id) === String(item.id))) students.push(item);
                });
            }

            const { data: t2 } = await supabase
                .from('teachers')
                .select('id, full_name, profile_image, profile_url, phone')
                .in('id', stringIds);
            if (t2) {
                t2.forEach(item => {
                    if (!teachers.some(x => String(x.id) === String(item.id))) teachers.push(item);
                });
            }
        }

        const usersMap = {};
        students.forEach(s => {
            const info = {
                full_name: s.full_name || 'طالب',
                profile_image: s.profile_url || s.profile_image || '',
                phone: s.phone || '',
                is_teacher: false
            };
            usersMap[String(s.id)] = info;
        });

        teachers.forEach(t => {
            const isGroupTeacher = String(group.teacher_id) === String(t.id);
            const info = {
                full_name: (t.full_name || 'أستاذ') + (isGroupTeacher ? ' (مالك المجموعة)' : ' (أستاذ)'),
                profile_image: t.profile_url || t.profile_image || '',
                phone: '', // دمج الخصوصية: رقم هاتف المالك/الأستاذ دائماً مخفي ومحمي
                is_teacher: true
            };
            usersMap[String(t.id)] = info;
        });

        const blockedMap = {};
        const joinedAtMap = {};
        membersList.forEach(m => {
            const sId = String(m.student_id || m.user_id || '');
            if (sId) {
                blockedMap[sId] = !!m.is_blocked;
                joinedAtMap[sId] = m.created_at || m.joined_at;
            }
        });

        const result = uniqueIds.map(id => {
            const key = String(id);
            const isOwner = group.teacher_id && String(group.teacher_id) === key;
            const userInfo = usersMap[key] || {
                full_name: isOwner ? 'مالك المجموعة' : 'عضو في المجموعة',
                profile_image: '',
                phone: '',
                is_teacher: isOwner
            };

            return {
                student_id: id,
                is_blocked: !isOwner && !!blockedMap[key],
                joined_at: joinedAtMap[key] || group.created_at || new Date().toISOString(),
                full_name: userInfo.full_name,
                profile_image: userInfo.profile_image,
                phone: '', // إخفاء أرقام جميع أعضاء المجموعة لزيادة الخصوصية والأمان
                is_owner: isOwner,
                is_teacher: userInfo.is_teacher
            };
        });

        res.json(result);
    } catch (error) {
        console.error('Error fetching group members:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء جلب الأعضاء' });
    }
});

// طرد طالب أو عضو من المجموعة (فقط مالك/منشئ المجموعة)
router.post('/:id/kick', authenticate, authorize(['teacher']), async (req, res) => {
    const groupId = req.params.id;
    const { studentId } = req.body;
    const teacherId = req.user.userId;

    if (!studentId) {
        return res.status(400).json({ error: 'معرف العضو مطلوب' });
    }

    const numericGroupId = parseInt(groupId, 10);
    const numericStudentId = parseInt(studentId, 10);
    const gId = isNaN(numericGroupId) ? groupId : numericGroupId;
    const sId = isNaN(numericStudentId) ? studentId : numericStudentId;

    try {
        const { data: group } = await supabase
            .from('groups')
            .select('*')
            .eq('id', gId)
            .maybeSingle();

        if (!group || String(group.teacher_id) !== String(teacherId)) {
            return res.status(403).json({ error: 'غير مصرح لك! فقط منشئ ومالك هذه المجموعة يمكنه طرد الأعضاء.' });
        }

        if (String(group.teacher_id) === String(sId)) {
            return res.status(400).json({ error: 'لا يمكن طرد مالك المجموعة نفسه!' });
        }

        const { error } = await supabase
            .from('group_members')
            .delete()
            .eq('group_id', gId)
            .eq('student_id', sId);

        if (error) throw error;

        res.json({ success: true, message: 'تم طرد العضو من المجموعة بنجاح' });
    } catch (error) {
        console.error('Error kicking member:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء طرد العضو: ' + (error.message || '') });
    }
});

// حظر عضو من المجموعة (فقط مالك/منشئ المجموعة)
router.post('/:id/block', authenticate, authorize(['teacher']), async (req, res) => {
    const groupId = req.params.id;
    const { studentId } = req.body;
    const teacherId = req.user.userId;

    if (!studentId) {
        return res.status(400).json({ error: 'معرف العضو مطلوب' });
    }

    const numericGroupId = parseInt(groupId, 10);
    const numericStudentId = parseInt(studentId, 10);
    const gId = isNaN(numericGroupId) ? groupId : numericGroupId;
    const sId = isNaN(numericStudentId) ? studentId : numericStudentId;

    try {
        const { data: group } = await supabase
            .from('groups')
            .select('*')
            .eq('id', gId)
            .maybeSingle();

        if (!group || String(group.teacher_id) !== String(teacherId)) {
            return res.status(403).json({ error: 'غير مصرح لك! فقط منشئ ومالك هذه المجموعة يمكنه حظر الأعضاء.' });
        }

        if (String(group.teacher_id) === String(sId)) {
            return res.status(400).json({ error: 'لا يمكن حظر مالك المجموعة نفسه!' });
        }

        const { data: existing } = await supabase
            .from('group_members')
            .select('id')
            .eq('group_id', gId)
            .eq('student_id', sId)
            .maybeSingle();

        if (existing) {
            const { error: updErr } = await supabase
                .from('group_members')
                .update({ is_blocked: true })
                .eq('group_id', gId)
                .eq('student_id', sId);
            if (updErr) throw updErr;
        } else {
            const { error: insErr } = await supabase
                .from('group_members')
                .insert({
                    group_id: gId,
                    student_id: sId,
                    is_blocked: true
                });
            if (insErr) throw insErr;
        }

        res.json({ success: true, message: 'تم حظر العضو من المجموعة بنجاح' });
    } catch (error) {
        console.error('Error blocking member:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء حظر العضو: ' + (error.message || '') });
    }
});

// إلغاء حظر عضو من المجموعة (فقط مالك/منشئ المجموعة)
router.post('/:id/unblock', authenticate, authorize(['teacher']), async (req, res) => {
    const groupId = req.params.id;
    const { studentId } = req.body;
    const teacherId = req.user.userId;

    if (!studentId) {
        return res.status(400).json({ error: 'معرف العضو مطلوب' });
    }

    const numericGroupId = parseInt(groupId, 10);
    const numericStudentId = parseInt(studentId, 10);
    const gId = isNaN(numericGroupId) ? groupId : numericGroupId;
    const sId = isNaN(numericStudentId) ? studentId : numericStudentId;

    try {
        const { data: group } = await supabase
            .from('groups')
            .select('*')
            .eq('id', gId)
            .maybeSingle();

        if (!group || String(group.teacher_id) !== String(teacherId)) {
            return res.status(403).json({ error: 'غير مصرح لك! فقط منشئ ومالك هذه المجموعة يملك صلاحية إلغاء الحظر.' });
        }

        const { error } = await supabase
            .from('group_members')
            .update({ is_blocked: false })
            .eq('group_id', gId)
            .eq('student_id', sId);

        if (error) throw error;

        res.json({ success: true, message: 'تم إلغاء حظر العضو بنجاح' });
    } catch (error) {
        console.error('Error unblocking member:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء إلغاء حظر العضو: ' + (error.message || '') });
    }
});

// حذف مجموعة بالكامل (فقط مالك ومنشئ المجموعة)
router.delete('/:id', authenticate, authorize(['teacher']), async (req, res) => {
    const groupId = req.params.id;
    const teacherId = req.user.userId;

    try {
        const numericGroupId = parseInt(groupId, 10);
        const gId = isNaN(numericGroupId) ? groupId : numericGroupId;

        const { data: group } = await supabase
            .from('groups')
            .select('*')
            .eq('id', gId)
            .maybeSingle();

        if (!group || String(group.teacher_id) !== String(teacherId)) {
            return res.status(403).json({ error: 'غير مصرح لك بحذف هذه المجموعة! فقط منشئ ومالك المجموعة يملك هذه الصلاحية.' });
        }

        await supabase.from('group_messages').delete().eq('group_id', gId);
        await supabase.from('group_members').delete().eq('group_id', gId);
        const { error } = await supabase.from('groups').delete().eq('id', gId);
        if (error) throw error;

        res.json({ success: true, message: 'تم حذف المجموعة بنجاح' });
    } catch (error) {
        console.error('Error deleting group:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء حذف المجموعة' });
    }
});

module.exports = router;
