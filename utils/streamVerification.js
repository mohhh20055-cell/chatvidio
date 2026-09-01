const logger = require('./logger');
const { sendStreamStartReminderEmail } = require('./email');
// ============================================================
// نظام التحقق المستقل من وقت البث - Stream Verification System
// ============================================================

const { supabase } = require('../config/database');
const axios = require('axios');

// ============================================================
// دوال التحقق من Jitsi
// ============================================================

/**
 * التحقق من غرفة Jitsi وجمع معلوماتها
 * ملاحظة: Jitsi لا يوفر API عام للتحقق من الاجتماعات
 * لذلك نستخدم نظامنا الداخلي للتحقق
 */
async function verifyJitsiRoom(roomName) {
    try {
        // التحقق من وجود الغرفة في جدول الدروس
        const { data: offer, error } = await supabase
            .from('offers')
            .select('id, room_name, stream_url, status, stream_started_at')
            .eq('room_name', roomName)
            .single();

        if (error || !offer) {
            return { valid: false, error: 'الغرفة غير موجودة' };
        }

        // التحقق من حالة البث
        if (offer.status !== 'live' && offer.status !== 'paused') {
            return { valid: false, error: 'البث ليس نشطاً' };
        }

        return {
            valid: true,
            offer: offer,
            roomActive: true
        };
    } catch (error) {
        logger.error('خطأ في التحقق من Jitsi:', error.message);
        return { valid: false, error: error.message };
    }
}

/**
 * تسجيل بداية البث المستقلة (timestamp من الخادم)
 */
async function recordStreamStart(offerId, teacherId) {
    const serverTimestamp = new Date().toISOString();

    const { data, error } = await supabase
        .from('stream_verification')
        .insert({
            offer_id: offerId,
            teacher_id: teacherId,
            server_start_time: serverTimestamp,
            status: 'started',
            created_at: serverTimestamp
        })
        .select()
        .single();

    if (error) {
        logger.error('خطأ في تسجيل بداية البث:', error.message);
        // إذا فشل الإدراج، حاول التحديث
        await supabase
            .from('stream_verification')
            .update({
                server_start_time: serverTimestamp,
                status: 'started'
            })
            .eq('offer_id', offerId)
            .eq('teacher_id', teacherId);
    }

    return data;
}

/**
 * تسجيل إيقاف البث مؤقتاً
 */
async function recordStreamPause(offerId) {
    const serverTimestamp = new Date().toISOString();

    const { data, error } = await supabase
        .from('stream_verification')
        .update({
            last_pause_time: serverTimestamp,
            total_paused_seconds: supabase.rpc('add_seconds', {
                current: supabase.rpc('get_total_paused', { offer_id: offerId }),
                add: serverTimestamp
            })
        })
        .eq('offer_id', offerId)
        .select()
        .single();

    return data;
}

/**
 * حساب الوقت الفعلي للبث من الخادم
 */
async function calculateActualStreamDuration(offerId) {
    const { data: verification, error } = await supabase
        .from('stream_verification')
        .select('*')
        .eq('offer_id', offerId)
        .single();

    if (error || !verification) {
        return null;
    }

    if (!verification.server_start_time) {
        return {
            total_seconds: 0,
            paused_seconds: 0,
            actual_live_seconds: 0,
            started_at: null,
            ended_at: verification.server_end_time
        };
    }

    const startTime = new Date(verification.server_start_time);
    if (isNaN(startTime.getTime())) {
        return {
            total_seconds: 0,
            paused_seconds: 0,
            actual_live_seconds: 0,
            started_at: verification.server_start_time,
            ended_at: verification.server_end_time
        };
    }

    const endTime = verification.server_end_time 
        ? new Date(verification.server_end_time) 
        : new Date();
    
    let totalSeconds = Math.floor((endTime - startTime) / 1000);
    if (isNaN(totalSeconds) || totalSeconds < 0) {
        totalSeconds = 0;
    }
    
    // حساب وقت الإيقاف الكلي (يمكن تحسينه لاحقاً)
    const pausedSeconds = verification.total_paused_seconds || 0;
    
    // الوقت الفعلي للبث = الوقت الكلي - وقت الإيقاف
    let actualLiveSeconds = Math.max(0, totalSeconds - pausedSeconds);
    if (isNaN(actualLiveSeconds)) {
        actualLiveSeconds = 0;
    }

    return {
        total_seconds: totalSeconds,
        paused_seconds: pausedSeconds,
        actual_live_seconds: actualLiveSeconds,
        started_at: verification.server_start_time,
        ended_at: verification.server_end_time
    };
}

/**
 * إنهاء البث وتسجيل الوقت النهائي
 */
async function recordStreamEnd(offerId, teacherId) {
    const serverTimestamp = new Date().toISOString();

    // البحث عن سجل التحقق
    const { data: existing, error: findError } = await supabase
        .from('stream_verification')
        .select('*')
        .eq('offer_id', offerId)
        .single();

    let updateData = {
        server_end_time: serverTimestamp,
        status: 'completed'
    };

    // حساب الوقت الفعلي للبث
    if (existing && existing.server_start_time) {
        const startTime = new Date(existing.server_start_time);
        const endTime = new Date(serverTimestamp);
        const totalSeconds = Math.floor((endTime - startTime) / 1000);
        
        updateData.total_duration_seconds = totalSeconds;
        
        // حساب وقت الإيقاف
        const pausedSeconds = existing.total_paused_seconds || 0;
        updateData.actual_live_seconds = Math.max(0, totalSeconds - pausedSeconds);
    }

    if (existing) {
        // تحديث السجل الموجود
        const { data, error } = await supabase
            .from('stream_verification')
            .update(updateData)
            .eq('offer_id', offerId)
            .select()
            .single();

        return data;
    } else {
        // إنشاء سجل جديد إذا لم يكن موجوداً
        const { data, error } = await supabase
            .from('stream_verification')
            .insert({
                offer_id: offerId,
                teacher_id: teacherId,
                server_start_time: serverTimestamp,
                server_end_time: serverTimestamp,
                total_duration_seconds: 0,
                actual_live_seconds: 0,
                status: 'completed',
                created_at: serverTimestamp
            })
            .select()
            .single();

        return data;
    }
}

/**
 * التحقق من اكتمال البث للمحفظة
 */
async function verifyStreamCompletion(offerId) {
    const { data: offer, error: offerError } = await supabase
        .from('offers')
        .select('id, duration, total_seconds, remaining_seconds, stream_started_at, teacher_id, subject_name, price')
        .eq('id', offerId)
        .single();

    if (offerError || !offer) {
        logger.error(`verifyStreamCompletion: error fetching offer ${offerId}:`, offerError ? offerError.message : 'Not found');
        return { complete: false, completion_percentage: 0, error: 'الدرس غير موجود' };
    }

    // 1. مدة البث المخطط لها بالثواني بناءً على بيانات الأستاذ
    const durationMins = offer.duration || 60;
    const expectedDuration = Number(offer.total_seconds || (durationMins * 60)) || 3600;
    
    // 50 دقيقة كحد أدنى لإكمال الحصة (سواء كانت ساعة أو أقل، نحتاج 50/60 من المدة المطلوبة)
    const requiredDuration = expectedDuration * (50/60);

    // 2. حساب الوقت المنقضي بناءً على موقت الأستاذ المقاس بالسيرفر
    let actualDurationFromTimer = 0;
    const remainingSec = (offer.remaining_seconds != null && !isNaN(Number(offer.remaining_seconds))) 
        ? Number(offer.remaining_seconds) 
        : null;

    if (remainingSec !== null) {
        // الوقت المنقضي = الوقت الكلي - الوقت المتبقي في موقت الأستاذ
        actualDurationFromTimer = Math.max(0, expectedDuration - remainingSec);
    }

    // 3. حساب الوقت المنقضي بناءً على زمن بدء البث إن وجد
    let actualDurationFromStartTime = 0;
    if (offer.stream_started_at) {
        const startTime = new Date(offer.stream_started_at).getTime();
        if (!isNaN(startTime)) {
            actualDurationFromStartTime = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
        }
    }

    // 4. جلب سجل التحقق إن وجد
    const verification = await calculateActualStreamDuration(offerId);
    const actualDurationFromVerif = verification ? (verification.actual_live_seconds || 0) : 0;

    // قياس الوقت المنقضي الفعلي من موقت الأستاذ أو السيرفر
    let actualDuration = Math.max(actualDurationFromTimer, actualDurationFromStartTime, actualDurationFromVerif);
    
    // تأكيد ألا يتجاوز الوقت الفعلي مدة البث الكلية
    actualDuration = Math.min(expectedDuration, actualDuration);

    // التحقق من أن الاستاذ أتم 50 دقيقة على الأقل
    const isComplete = actualDuration >= requiredDuration;

    let completionPercentage = (actualDuration / expectedDuration) * 100;
    if (isNaN(completionPercentage) || completionPercentage < 0) {
        completionPercentage = 0;
    }
    completionPercentage = Math.min(100, Math.round(completionPercentage * 100) / 100);

    // ✅ حفظ نسبة الإكتمال والمدة الفعلية للبث في قاعدة البيانات (جدول offers وجدول stream_verification)
    const completionPctRounded = Math.round(completionPercentage);
    try {
        await supabase
            .from('offers')
            .update({
                completion_percentage: completionPctRounded,
                actual_duration: actualDuration,
                actual_live_seconds: actualDuration
            })
            .eq('id', offerId);
    } catch(e) {}

    try {
        await supabase
            .from('stream_verification')
            .update({
                actual_live_seconds: actualDuration,
                total_duration_seconds: expectedDuration,
                completion_percentage: completionPctRounded
            })
            .eq('offer_id', offerId);
    } catch(e) {}

    return {
        complete: isComplete,
        completion_percentage: completionPercentage,
        expected_seconds: expectedDuration,
        actual_seconds: actualDuration,
        shortfall_seconds: Math.max(0, expectedDuration - actualDuration)
    };
}

/**
 * معالجة المدفوعات حسب وقت البث الفعلي
 */
async function processStreamPayments(offerId, earlyEnd = false) {
    
    // إذا كان إنهاء مبكر، استرداد كامل للطلاب
    if (earlyEnd) {
        return await processEarlyEndRefund(offerId);
    }
    
    // Otherwise, process normal completion with partial payments
    const completion = await verifyStreamCompletion(offerId);
    
    const { data: offer, error: offerError } = await supabase
        .from('offers')
        .select('id, teacher_id, price, subject_name, is_free, price_per_session')
        .eq('id', offerId)
        .single();

    if (offerError || !offer) {
        logger.error('خطأ في جلب الدرس:', offerError);
        return;
    }

    // إذا كان مجانياً، لا حاجة للمعالجة
    const isOfferFree = offer ? (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1 || offer.price === 0 || parseFloat(offer.price) === 0) : false;
    if (isOfferFree) {
        console.log('الدرس مجاني، لا حاجة لمعالجة المدفوعات');
        return;
    }

    // جلب جميع الجلسات المعلقة لهذا الدرس
    const { data: sessions, error: sessionsError } = await supabase
        .from('sessions')
        .select('id, student_id, payment_amount, payment_status')
        .eq('offer_id', offerId)
        .eq('payment_status', 'pending_stream');

    if (sessionsError) {
        logger.error('خطأ في جلب الجلسات:', sessionsError);
        return;
    }

    console.log(`📊 جاري معالجة ${sessions?.length || 0} جلسة للبث ${offerId}`);

    for (const session of (sessions || [])) {
        // إذا كان البث مكتملاً (إتمام 50 دقيقة على الأقل)، يعتبر مكتملاً ولا يوجد استرداد
        const isCompleted = completion.complete;
        const completionPctRounded = Math.round(completion.completion_percentage);

        if (isCompleted) {
            // البث مكتمل - لا استرداد للطالب، الأستاذ يحصل على سعر الحصة
            const teacherAmount = isOfferFree ? 0 : (parseFloat(offer.price_per_session || offer.price || 0));

            // تحديث حالة الجلسة ونسبة الإكتمال
            await supabase
                .from('sessions')
                .update({
                    payment_status: 'paid',
                    teacher_earned: teacherAmount,
                    completed_at: new Date().toISOString(),
                    completion_percentage: completionPctRounded,
                    actual_duration: completion.actual_seconds,
                    partial_payment_note: `بث مكتمل - نسبة الإكتمال: ${completionPctRounded}%`
                })
                .eq('id', session.id);

            // إضافة للأستاذ
            if (teacherAmount > 0) {
                const { data: teacher } = await supabase
                    .from('teachers')
                    .select('pending_withdraw, total_earned')
                    .eq('id', offer.teacher_id)
                    .single();

                await supabase
                    .from('teachers')
                    .update({
                        pending_withdraw: Math.max(0, (teacher?.pending_withdraw || 0) - teacherAmount),
                        total_earned: (teacher?.total_earned || 0) + teacherAmount
                    })
                    .eq('id', offer.teacher_id);
                
                console.log(`✅ تم تحويل ${teacherAmount} دج للأستاذ (بث مكتمل بنسبة ${completionPctRounded}%)`);
            }
        } else {
            // البث غير مكتمل (أقل من 80%) - استرداد كامل للطالب في الحصص المدفوعة، لا شيء للأستاذ
            const teacherAmount = 0;
            const refundAmount = Math.max(0, session.payment_amount - 100); // استرداد مبلغ الحصه فقط بدون رسوم 100

            // تحديث حالة الجلسة ونسبة الإكتمال
            await supabase
                .from('sessions')
                .update({
                    payment_status: 'refunded',
                    teacher_earned: teacherAmount,
                    completed_at: new Date().toISOString(),
                    completion_percentage: completionPctRounded,
                    actual_duration: completion.actual_seconds,
                    partial_payment_note: `استرداد - البث غير مكتمل (نسبة الإكتمال: ${completionPctRounded}%)`
                })
                .eq('id', session.id);

            // إزالة المبلغ المعلق من الأستاذ إذا كان قد أضيف له
            const originalTeacherEarned = isOfferFree ? 0 : (offer.price || 0);
            if (originalTeacherEarned > 0) {
                const { data: teacher } = await supabase
                    .from('teachers')
                    .select('pending_withdraw')
                    .eq('id', offer.teacher_id)
                    .single();

                await supabase
                    .from('teachers')
                    .update({
                        pending_withdraw: Math.max(0, (teacher?.pending_withdraw || 0) - originalTeacherEarned)
                    })
                    .eq('id', offer.teacher_id);
            }

            if (refundAmount > 0) {
                // استرداد المبلغ للطالب
                const { data: student } = await supabase
                    .from('students')
                    .select('wallet_balance')
                    .eq('id', session.student_id)
                    .single();

                await supabase
                    .from('students')
                    .update({
                        wallet_balance: (student?.wallet_balance || 0) + refundAmount
                    })
                    .eq('id', session.student_id);

                // تسجيل المعاملة
                await supabase
                    .from('wallet_transactions')
                    .insert({
                        student_id: session.student_id,
                        amount: refundAmount,
                        type: 'refund',
                        status: 'completed',
                        description: `استرداد كامل ${refundAmount} دج - البث لم يكتمل (${Math.round(completion.completion_percentage)}% فقط)`,
                        created_at: new Date().toISOString()
                    });

                console.log(`💰 تم استرداد كامل ${refundAmount} دج للطالب`);

                // إشعار الطالب بالاسترداد
                await supabase
                    .from('notifications')
                    .insert({
                        user_id: session.student_id,
                        user_type: 'student',
                        title: '💰 استرداد كامل',
                        message: `تم استرداد كامل المبلغ (${refundAmount} دج) لحصة "${offer.subject_name}" بسبب عدم إكمال مدة البث المطلوبة (50 دقيقة).`,
                        is_read: false,
                        created_at: new Date().toISOString()
                    });
            }
        }

        // إشعار الأستاذ
        await supabase
            .from('notifications')
            .insert({
                user_id: offer.teacher_id,
                user_type: 'teacher',
                title: '📊 تقرير البث',
                message: `تم إنهاء البث "${offer.subject_name}". ${completion.complete ? 'تمت الحصة بنجاح.' : 'لم يتم إكمال مدة البث المطلوبة (50 دقيقة).'}`,
                is_read: false,
                created_at: new Date().toISOString()
            });
    }

    // إذا كان العرض يحتوي على خطة اشتراك متعددة الحصص، نحرر دفعة الحصة الحالية
    if (offer && (offer.total_sessions > 1 || offer.plan_type)) {
        try {
            await releasePlanSessionEscrow(offerId);
        } catch (e) {
            console.error('خطأ في تحرير مستحقات حصة الخطة:', e.message);
        }
    }
}

/**
 * تحرير مستحقات حصة محددة ضمن خطة اشتراك
 * @param {number} offerId 
 * @param {number} sessionNumber - رقم الحصة (اختياري، إن لم يحدد يتم أخذ الحصة التالية غير المكتملة)
 */
async function releasePlanSessionEscrow(offerId, sessionNumber = null) {
    try {
        const { data: offer, error: offerError } = await supabase
            .from('offers')
            .select('*')
            .eq('id', offerId)
            .single();

        if (offerError || !offer) {
            console.error('العرض غير موجود لتحرير المستحقات:', offerId);
            return { success: false, error: 'الدرس غير موجود' };
        }

        const totalSessions = offer.total_sessions || 1;
        const pricePerSession = parseFloat(offer.price_per_session || offer.price || 0);
        const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && pricePerSession === 0;

        if (isFree || pricePerSession <= 0) {
            console.log('الحصة مجانية - لا توجد مستحقات لتحريرها');
            return { success: true, message: 'حصة مجانية' };
        }

        // جلب الحصص المجدولة
        const { data: streamSessions } = await supabase
            .from('stream_sessions')
            .select('*')
            .eq('offer_id', offerId)
            .order('session_number', { ascending: true });

        let targetSession = null;
        if (sessionNumber) {
            targetSession = (streamSessions || []).find(s => s.session_number === sessionNumber);
        } else {
            // أول حصة غير مكتملة
            targetSession = (streamSessions || []).find(s => s.status !== 'completed');
            if (!targetSession && streamSessions && streamSessions.length > 0) {
                targetSession = streamSessions[streamSessions.length - 1];
            }
        }

        const currentSessionNum = targetSession ? targetSession.session_number : ((offer.completed_sessions_count || 0) + 1);

        // عدد الطلاب المشتركين
        const { count: studentCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offerId)
            .in('payment_status', ['pending_stream', 'paid']);

        const activeSubscribers = studentCount || offer.booked_count || 1;
        const amountToRelease = pricePerSession * activeSubscribers;

        // تحديث رصيد المعلم: نقل المبلغ من المعلق إلى المتاح والأرباح
        const { data: teacher } = await supabase
            .from('teachers')
            .select('pending_withdraw, total_earned, balance')
            .eq('id', offer.teacher_id)
            .single();

        if (teacher) {
            const newPending = Math.max(0, (parseFloat(teacher.pending_withdraw) || 0) - amountToRelease);
            const newEarned = (parseFloat(teacher.total_earned) || 0) + amountToRelease;
            const newBalance = (parseFloat(teacher.balance) || 0) + amountToRelease;

            await supabase
                .from('teachers')
                .update({
                    pending_withdraw: newPending,
                    total_earned: newEarned,
                    balance: newBalance
                })
                .eq('id', offer.teacher_id);
        }

        // تسجيل في جدول stream_escrow_releases
        try {
            await supabase
                .from('stream_escrow_releases')
                .insert({
                    offer_id: offerId,
                    teacher_id: offer.teacher_id,
                    session_number: currentSessionNum,
                    amount_released: amountToRelease,
                    students_count: activeSubscribers,
                    note: `تحرير مستحقات الحصة رقم ${currentSessionNum} بمبلغ ${amountToRelease} دج (${activeSubscribers} طالب × ${pricePerSession} دج)`,
                    created_at: new Date().toISOString()
                });
        } catch (e) {
            console.warn('⚠️ تعذر إدراج stream_escrow_releases:', e.message);
        }

        // تحديث stream_sessions
        if (targetSession) {
            try {
                await supabase
                    .from('stream_sessions')
                    .update({
                        status: 'completed',
                        completed_at: new Date().toISOString(),
                        teacher_released_amount: amountToRelease,
                        is_escrow_released: true
                    })
                    .eq('id', targetSession.id);
            } catch (e) {
                console.warn('⚠️ تعذر تحديث stream_sessions:', e.message);
            }
        }

        // تحديث عدد الحصص المكتملة في العرض وتحديث جدول الحصص sessions_schedule
        const newCompletedCount = Math.min(totalSessions, (offer.completed_sessions_count || 0) + 1);
        let updatedSchedule = offer.sessions_schedule || [];
        if (Array.isArray(updatedSchedule)) {
            updatedSchedule = updatedSchedule.map(s => {
                if (s.session_number === currentSessionNum) {
                    return { ...s, status: 'completed', completed_at: new Date().toISOString(), is_escrow_released: true };
                }
                return s;
            });
        }

        const isAllCompleted = newCompletedCount >= totalSessions;
        const offerUpdates = {
            completed_sessions_count: newCompletedCount,
            sessions_schedule: updatedSchedule,
            total_released_amount: (parseFloat(offer.total_released_amount) || 0) + amountToRelease
        };

        if (isAllCompleted) {
            offerUpdates.status = 'completed';
            offerUpdates.completed_at = new Date().toISOString();
        }

        await supabase
            .from('offers')
            .update(offerUpdates)
            .eq('id', offerId);

        // تحديث اشتراكات الطلاب
        try {
            await supabase
                .from('stream_subscriptions')
                .update({
                    completed_sessions: newCompletedCount,
                    teacher_released_so_far: (parseFloat(offer.total_released_amount) || 0) + amountToRelease,
                    status: isAllCompleted ? 'completed' : 'active',
                    updated_at: new Date().toISOString()
                })
                .eq('offer_id', offerId);
        } catch (e) {
            console.warn('⚠️ تعذر تحديث stream_subscriptions:', e.message);
        }

        // إشعار الأستاذ بتحرير الدفعة
        await supabase
            .from('notifications')
            .insert({
                user_id: offer.teacher_id,
                user_type: 'teacher',
                title: '💰 تم تحرير مستحقات الحصة',
                message: `تم تحرير مبلغ ${amountToRelease} دج وإضافته لأرباحك بعد اكتمال الحصة رقم (${currentSessionNum}) من إجمالي (${totalSessions}) حصص في خطة "${offer.subject_name}".`,
                is_read: false,
                created_at: new Date().toISOString()
            });

        console.log(`✅ تم بنجاح تحرير ${amountToRelease} دج للأستاذ عن الحصة ${currentSessionNum}/${totalSessions}`);
        return {
            success: true,
            session_number: currentSessionNum,
            amount_released: amountToRelease,
            completed_sessions_count: newCompletedCount,
            is_all_completed: isAllCompleted
        };
    } catch (err) {
        console.error('خطأ في تحرير مستحقات الحصة:', err);
        return { success: false, error: err.message };
    }
}

/**
 * معالجة الاسترداد الكامل عند الإنهاء المبكر
 * - لا يحصل الأستاذ على أي مال
 * - يتم استرداد جميع الأموال للطلاب
 */
async function processEarlyEndRefund(offerId) {
    const { data: offer, error: offerError } = await supabase
        .from('offers')
        .select('id, teacher_id, subject_name, is_free, price')
        .eq('id', offerId)
        .single();

    if (offerError || !offer) {
        logger.error('خطأ في جلب الدرس للاسترداد:', offerError);
        return;
    }

    // إذا كان مجانياً، لا حاجة للمعالجة
    const isOfferFree = offer ? (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1 || offer.price === 0 || parseFloat(offer.price) === 0) : false;
    if (isOfferFree) {
        console.log('الدرس مجاني، لا حاجة لمعالجة الاسترداد');
        return;
    }

    // جلب جميع الجلسات المعلقة
    const { data: sessions, error: sessionsError } = await supabase
        .from('sessions')
        .select('id, student_id, payment_amount, payment_status')
        .eq('offer_id', offerId)
        .eq('payment_status', 'pending_stream');

    if (sessionsError) {
        logger.error('خطأ في جلب الجلسات:', sessionsError);
        return;
    }

    console.log(`⚠️ معالجة إنهاء مبكر للبث ${offerId} - استرداد كامل للطلاب`);

    for (const session of (sessions || [])) {
        // التحقق الإضافي من الحالة قبل المعالجة (تجنب التكرار)
        const { data: currentSession } = await supabase
            .from('sessions')
            .select('payment_status')
            .eq('id', session.id)
            .single();
            
        if (!currentSession || currentSession.payment_status !== 'pending_stream') {
            console.log(`ℹ️ الجلسة ${session.id} تم استردادها بالفعل أو تغيرت حالتها`);
            continue;
        }

        // استرداد كامل للمبلغ للطالب (باستثناء رسوم السيرفر 100)
        const { data: student } = await supabase
            .from('students')
            .select('wallet_balance')
            .eq('id', session.student_id)
            .single();

        await supabase
            .from('students')
            .update({
                wallet_balance: (student?.wallet_balance || 0) + Math.max(0, session.payment_amount - 100)
            })
            .eq('id', session.student_id);

        // تحديث حالة الجلسة
        await supabase
            .from('sessions')
            .update({
                payment_status: 'refunded',
                teacher_earned: 0,
                completed_at: new Date().toISOString(),
                partial_payment_note: 'استرداد مبلغ الحصة - أنهى الأستاذ البث مبكراً'
            })
            .eq('id', session.id);

        // تسجيل المعاملة
        await supabase
            .from('wallet_transactions')
            .insert({
                student_id: session.student_id,
                amount: Math.max(0, session.payment_amount - 100),
                type: 'refund',
                status: 'completed',
                description: `استرداد مبلغ الحصة ${Math.max(0, session.payment_amount - 100)} دج - أنهى الأستاذ البث مبكراً`,
                created_at: new Date().toISOString()
            });

        // إشعار الطالب
        await supabase
            .from('notifications')
            .insert({
                user_id: session.student_id,
                user_type: 'student',
                title: '💰 استرداد مبلغ الحصة',
                message: `تم استرداد ${Math.max(0, session.payment_amount - 100)} دج لحصة "${offer.subject_name}" لأن الأستاذ أنهى البث مبكراً`,
                is_read: false,
                created_at: new Date().toISOString()
            });

        console.log(`💰 تم استرداد ${session.payment_amount} دج للطالب ${session.student_id}`);
    }

    // تحديث رصيد الأستاذ المعلق (إلغاء المعلق)
    const { data: teacher } = await supabase
        .from('teachers')
        .select('pending_withdraw')
        .eq('id', offer.teacher_id)
        .single();

    if (teacher?.pending_withdraw > 0) {
        await supabase
            .from('teachers')
            .update({
                pending_withdraw: 0
            })
            .eq('id', offer.teacher_id);
    }

    // إشعار الأستاذ
    await supabase
        .from('notifications')
        .insert({
            user_id: offer.teacher_id,
            user_type: 'teacher',
            title: '⚠️ تم إنهاء البث مبكراً',
            message: `تم إنهاء البث "${offer.subject_name}" مبكراً. لم تحصل على أي مال وتم استرداد جميع المبالغ للطلاب.`,
            is_read: false,
            created_at: new Date().toISOString()
        });

    console.log(`⚠️ تم إنهاء البث مبكراً - لم يحصل الأستاذ على أي مال`);
}

/**
 * جلب بيانات التحقق للبث
 */
async function getStreamVerification(offerId) {
    const { data: verification, error } = await supabase
        .from('stream_verification')
        .select('*')
        .eq('offer_id', offerId)
        .single();

    if (error || !verification) {
        return null;
    }

    const { data: offer } = await supabase
        .from('offers')
        .select('duration')
        .eq('id', offerId)
        .single();

    const completion = await verifyStreamCompletion(offerId);

    return {
        ...verification,
        expected_duration: offer ? offer.duration * 60 : 0,
        completion_percentage: completion.completion_percentage,
        is_complete: completion.complete
    };
}

/**
 * انتهاء الدرس قبل بدئه (فات أوانه أو انقضت مدته بدون بث)
 * يُرجع أموال الطلاب الذين حجزوا ويحذف الدرس نهائياً من قاعدة البيانات
 */
async function expireOverdueOffer(offerId) {
    const { data: offer, error: offerError } = await supabase
        .from('offers')
        .select('id, teacher_id, subject_name, price, is_free, status, offer_date, duration')
        .eq('id', offerId)
        .single();

    if (offerError || !offer) {
        logger.error('expireOverdueOffer: الدرس غير موجود', offerId);
        return;
    }

    if (['completed', 'expired'].includes(offer.status)) return;

    console.log(`⏰ انتهاء الدرس ${offerId} (${offer.subject_name}) - جاري رد الأموال وحذف الدرس`);

    const isOfferFree = offer ? (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1 || offer.price === 0 || parseFloat(offer.price) === 0) : false;

    if (!isOfferFree) {
        // رد أموال الطلاب الذين دفعوا (paid أو pending_stream)
        const { data: sessions } = await supabase
            .from('sessions')
            .select('id, student_id, payment_amount, payment_status')
            .eq('offer_id', offerId)
            .in('payment_status', ['paid', 'pending_stream']);

        for (const session of (sessions || [])) {
            const { data: student } = await supabase
                .from('students')
                .select('wallet_balance')
                .eq('id', session.student_id)
                .single();

            await supabase
                .from('students')
                .update({ wallet_balance: (student?.wallet_balance || 0) + session.payment_amount })
                .eq('id', session.student_id);

            await supabase
                .from('sessions')
                .update({
                    payment_status: 'refunded',
                    teacher_earned: 0,
                    partial_payment_note: 'استرداد كامل - الدرس انتهى قبل البدء أو فات أوانه'
                })
                .eq('id', session.id);

            await supabase.from('wallet_transactions').insert({
                student_id: session.student_id,
                amount: session.payment_amount,
                type: 'refund',
                status: 'completed',
                description: `استرداد ${session.payment_amount} دج - الدرس "${offer.subject_name}" لم يُقام`,
                created_at: new Date().toISOString()
            });

            await supabase.from('notifications').insert({
                user_id: session.student_id,
                user_type: 'student',
                title: '💰 استرداد تلقائي',
                message: `تم استرداد ${session.payment_amount} دج - لم تُقام حصة "${offer.subject_name}" في الموعد المحدد`,
                is_read: false,
                created_at: new Date().toISOString()
            });

            console.log(`💰 استرداد ${session.payment_amount} دج للطالب ${session.student_id}`);
        }
    }

    // إشعار الأستاذ
    await supabase.from('notifications').insert({
        user_id: offer.teacher_id,
        user_type: 'teacher',
        title: '⏰ تم إلغاء وحذف الدرس تلقائياً',
        message: `الدرس "${offer.subject_name}" تم إلغاؤه وحذفه تلقائياً لأنه لم يُبدأ في الوقت المحدد وانتهت مدته.`,
        is_read: false,
        created_at: new Date().toISOString()
    });

    // ✅ حذف البيانات المرتبطة بالدرس من الجداول التابعة
    const tables = [
        'active_stream', 
        'waiting_room', 
        'student_room_passwords', 
        'stream_verification', 
        'stream_chat_messages', 
        'stream_mutes',
        'sessions'
    ];
    for (const table of tables) {
        try {
            await supabase.from(table).delete().eq('offer_id', offerId);
        } catch (e) {
            logger.error(`expireOverdueOffer: خطأ في حذف بيانات ${table}:`, e.message);
        }
    }

    // ✅ حذف الدرس نفسه من جدول offers
    try {
        await supabase
            .from('offers')
            .delete()
            .eq('id', offerId);
        console.log(`✅ تم حذف الدرس رقم ${offerId} بنجاح من قاعدة البيانات`);
    } catch (e) {
        logger.error('expireOverdueOffer: خطأ في حذف الدرس من جدول offers:', e.message);
    }
}

/**
 * إغلاق البث إجبارياً بعد انتهاء فترة السماح (10 دقائق)
 * يُستدعى من cron أو عند انتهاء grace period
 */
async function forceEndStream(offerId, reason = 'grace_timeout') {
    const { data: offer, error: offerError } = await supabase
        .from('offers')
        .select('id, teacher_id, subject_name, status, price, is_free')
        .eq('id', offerId)
        .single();

    if (offerError || !offer) return;
    if (!['live', 'paused'].includes(offer.status)) return;

    console.log(`🔴 إغلاق إجباري للبث ${offerId} - السبب: ${reason}`);

    // تسجيل نهاية البث
    await recordStreamEndWithReason(offerId, offer.teacher_id, reason);

    const completion = await verifyStreamCompletion(offerId);
    await processStreamPayments(offerId, false);

    // أرشفة سجل البث
    try {
        await archiveStreamLog(offerId, `force_ended_${reason}`, offer.teacher_id);
    } catch (archErr) {
        logger.error('⚠️ خطأ في أرشفة البث الإجباري:', archErr.message);
    }

    await supabase.from('offers').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        force_ended_at: new Date().toISOString()
    }).eq('id', offerId);

    await supabase.from('active_stream').delete().eq('offer_id', offerId);
    await supabase.from('waiting_room').delete().eq('offer_id', offerId);

    // إشعار الأستاذ
    const reasonMessages = {
        grace_timeout: 'انتهت فترة السماح (10 دقائق) بعد انتهاء وقت الحصة',
        heartbeat_lost: 'غادرت صفحة البث أثناء الحصة',
        expired_offer: 'انتهت مدة الدرس'
    };

    await supabase.from('notifications').insert({
        user_id: offer.teacher_id,
        user_type: 'teacher',
        title: '🔴 تم إغلاق البث تلقائياً',
        message: `تم إغلاق بث "${offer.subject_name}" تلقائياً - ${reasonMessages[reason] || reason}. يرجى إنشاء درس جديد لحصة جديدة.`,
        is_read: false,
        created_at: new Date().toISOString()
    });

    console.log(`✅ تم الإغلاق الإجباري للبث ${offerId}`);
}

/**
 * أرشفة وحفظ سجل البث المحذوف/المنتهي بكافة تفاصيله قبل الحذف
 * @param {number} offerId - معرف الدرس
 * @param {string} deleteReason - سبب الحذف/الإنهاء ('ended', 'deleted', 'early_end', 'force_ended')
 * @param {number|string} endedByUserId - معرف من قام بإيقاف/حذف البث
 */
async function archiveStreamLog(offerId, deleteReason = 'ended', endedByUserId = null) {
    try {
        if (!offerId) return null;

        // 1. جلب بيانات الدرس بالكامل من جدول offers
        const { data: offer } = await supabase
            .from('offers')
            .select('*')
            .eq('id', offerId)
            .single();

        if (!offer) {
            logger.warn(`archiveStreamLog: لم يتم العثور على الدرس ${offerId} لأرشفته`);
            return null;
        }

        // 2. جلب بيانات الأستاذ
        let teacherName = `أستاذ رقم ${offer.teacher_id}`;
        let teacherEmail = '';
        let teacherPhone = '';
        if (offer.teacher_id) {
            const { data: teacher } = await supabase
                .from('teachers')
                .select('full_name, email, phone')
                .eq('id', offer.teacher_id)
                .single();
            if (teacher) {
                teacherName = teacher.full_name || teacherName;
                teacherEmail = teacher.email || '';
                teacherPhone = teacher.phone || '';
            }
        }

        // 3. حساب نسب ومدد البث الفعلية
        let completion = { completion_percentage: offer.completion_percentage || 0, actual_seconds: offer.actual_duration || offer.actual_live_seconds || 0 };
        try {
            completion = await verifyStreamCompletion(offerId);
        } catch (e) {}

        // 4. جلب جميع الطلاب المسجلين/الحاضرين في الجلسات والغرفة لهذا البث
        let studentList = [];
        let totalEarningsCalculated = 0;
        let totalRefundedCalculated = 0;

        try {
            const { data: sessions } = await supabase
                .from('sessions')
                .select('id, student_id, payment_amount, payment_status, completion_percentage, actual_duration, partial_payment_note, created_at')
                .eq('offer_id', offerId);

            if (sessions && sessions.length > 0) {
                const studentIds = Array.from(new Set(sessions.map(s => s.student_id).filter(Boolean)));
                let studentMap = {};

                if (studentIds.length > 0) {
                    const { data: students } = await supabase
                        .from('students')
                        .select('id, full_name, email, phone')
                        .in('id', studentIds);

                    if (students) {
                        students.forEach(st => { studentMap[st.id] = st; });
                    }
                }

                studentList = sessions.map(sess => {
                    const st = studentMap[sess.student_id] || {};
                    const pAmount = Number(sess.payment_amount || offer.price || 0);
                    if (sess.payment_status === 'paid') {
                        totalEarningsCalculated += pAmount;
                    } else if (sess.payment_status === 'refunded') {
                        totalRefundedCalculated += pAmount;
                    }
                    return {
                        session_id: sess.id,
                        student_id: sess.student_id,
                        student_name: st.full_name || `طالب رقم ${sess.student_id}`,
                        student_email: st.email || '',
                        student_phone: st.phone || '',
                        payment_amount: pAmount,
                        payment_status: sess.payment_status || 'unknown',
                        note: sess.partial_payment_note || ''
                    };
                });
            } else {
                // إذا لم توجد جلسات، نبحث في غرفة الانتظار
                const { data: waiting } = await supabase
                    .from('waiting_room')
                    .select('student_id, created_at')
                    .eq('offer_id', offerId);

                if (waiting && waiting.length > 0) {
                    const studentIds = Array.from(new Set(waiting.map(w => w.student_id).filter(Boolean)));
                    if (studentIds.length > 0) {
                        const { data: students } = await supabase
                            .from('students')
                            .select('id, full_name, email, phone')
                            .in('id', studentIds);

                        studentList = (students || []).map(st => ({
                            student_id: st.id,
                            student_name: st.full_name || `طالب رقم ${st.id}`,
                            student_email: st.email || '',
                            student_phone: st.phone || '',
                            payment_amount: offer.price || 0,
                            payment_status: 'joined_waiting_room',
                            note: 'انضم لغرفة الانتظار/البث'
                        }));
                    }
                }
            }
        } catch (sessErr) {
            logger.error('archiveStreamLog: خطأ في جلب تفاصيل الطلاب والجلسات:', sessErr.message);
        }

        const expectedSeconds = offer.total_seconds || (offer.duration * 60) || (offer.duration_minutes * 60) || 3600;
        const actualLiveSeconds = completion.actual_seconds || offer.actual_duration || offer.actual_live_seconds || 0;
        const completionPct = Math.round(completion.completion_percentage || offer.completion_percentage || 0);

        // 5. بناء كائن الأرشيف النهائي الشامل
        const archiveRecord = {
            id: `stream_log_${Date.now()}_${offerId}`,
            offer_id: offerId,
            subject_name: offer.subject_name || offer.title || 'درس بدون عنوان',
            teacher_id: offer.teacher_id,
            teacher_name: teacherName,
            teacher_email: teacherEmail,
            teacher_phone: teacherPhone,
            price: Number(offer.price || 0),
            is_free: !!(offer.is_free || offer.price === 0),
            expected_duration_seconds: expectedSeconds,
            expected_duration_minutes: Math.round(expectedSeconds / 60),
            actual_live_seconds: actualLiveSeconds,
            actual_live_minutes: Math.round(actualLiveSeconds / 60),
            completion_percentage: completionPct,
            is_completed_80pct: completionPct >= 80,
            students_count: studentList.length,
            students_list: studentList,
            total_earned: totalEarningsCalculated,
            total_refunded: totalRefundedCalculated,
            stream_started_at: offer.stream_started_at || offer.created_at || null,
            stream_ended_at: new Date().toISOString(),
            archived_at: new Date().toISOString(),
            delete_reason: deleteReason,
            ended_by_user_id: endedByUserId,
            original_status: offer.status || 'unknown'
        };

        // 6. الحفظ في جدول archived_stream_logs أولاً
        try {
            await supabase.from('archived_stream_logs').insert(archiveRecord);
        } catch (dbErr) {
            logger.warn('archiveStreamLog: لم يتم الحفظ في جدول archived_stream_logs، سيتم الحفظ في platform_settings:', dbErr.message);
        }

        // 7. الحفظ أيضاً في platform_settings تحت المفتاح archived_stream_logs لضمان استمرارية الحفظ 100%
        try {
            const { data: settingData } = await supabase
                .from('platform_settings')
                .select('value')
                .eq('key', 'archived_stream_logs')
                .single();

            let logsList = (settingData && Array.isArray(settingData.value)) ? settingData.value : [];
            // تجنب تكرار إدخال نفس ID للدرس
            logsList = logsList.filter(item => String(item.offer_id) !== String(offerId));
            logsList.unshift(archiveRecord);
            if (logsList.length > 500) {
                logsList = logsList.slice(0, 500);
            }

            await supabase
                .from('platform_settings')
                .upsert({ key: 'archived_stream_logs', value: logsList });

            logger.info(`✅ تم أرشفة بيانات البث ${offerId} بنجاح في platform_settings`);
        } catch (psErr) {
            logger.error('archiveStreamLog: خطأ أثناء الحفظ في platform_settings:', psErr.message);
        }

        return archiveRecord;
    } catch (error) {
        logger.error('❌ خطأ كلي في archiveStreamLog:', error.message);
        return null;
    }
}

/**
 * نسخة من recordStreamEnd مع سبب الإنهاء
 */
async function recordStreamEndWithReason(offerId, teacherId, reason) {
    const serverTimestamp = new Date().toISOString();

    const { data: existing } = await supabase
        .from('stream_verification')
        .select('*')
        .eq('offer_id', offerId)
        .single();

    let updateData = {
        server_end_time: serverTimestamp,
        status: 'completed',
        end_reason: reason
    };

    if (existing?.server_start_time) {
        const totalSeconds = Math.floor((new Date(serverTimestamp) - new Date(existing.server_start_time)) / 1000);
        const pausedSeconds = existing.total_paused_seconds || 0;
        updateData.total_duration_seconds = totalSeconds;
        updateData.actual_live_seconds = Math.max(0, totalSeconds - pausedSeconds);
    }

    if (existing) {
        await supabase.from('stream_verification').update(updateData).eq('offer_id', offerId);
    } else {
        await supabase.from('stream_verification').insert({
            offer_id: offerId,
            teacher_id: teacherId,
            server_start_time: serverTimestamp,
            server_end_time: serverTimestamp,
            total_duration_seconds: 0,
            actual_live_seconds: 0,
            status: 'completed',
            end_reason: reason,
            created_at: serverTimestamp
        });
    }
}

/**
 * اكتشاف الدروس التي فات أوانها أو انتهت مدتها بدون بث
 * يُستدعى من cron كل دقيقة
 */
async function checkAndExpireOverdueOffers() {
    const now = new Date();

    // 0) التحقق من الدروس التي حان موعدها ولم يتم إرسال تنبيه للأستاذ عبر البريد بعد
    const { data: upcomingOffersForNotification } = await supabase
        .from('offers')
        .select('id, teacher_id, subject_name, offer_date, notification_sent')
        .eq('status', 'upcoming');

    for (const offer of (upcomingOffersForNotification || [])) {
        if (!offer.notification_sent && offer.offer_date) {
            const offerStart = new Date(offer.offer_date);
            if (now >= offerStart) {
                try {
                    const { data: teacher } = await supabase
                        .from('teachers')
                        .select('email, full_name')
                        .eq('id', offer.teacher_id)
                        .single();

                    if (teacher && teacher.email) {
                        await sendStreamStartReminderEmail(teacher.email, teacher.full_name || 'الأستاذ', offer.subject_name || 'درس مباشر', offer.id);
                    }

                    await supabase
                        .from('offers')
                        .update({ notification_sent: true })
                        .eq('id', offer.id);
                } catch (notifErr) {
                    console.error(`❌ خطأ في إرسال بريد تذكير موعد البث للدرس ${offer.id}:`, notifErr.message);
                }
            }
        }
    }

    // 1) دروس upcoming فات موعد بدئها + مدتها (أي لم تُبدأ أبداً)
    const { data: overdueOffers } = await supabase
        .from('offers')
        .select('id, offer_date, duration, subject_name')
        .eq('status', 'upcoming');

    for (const offer of (overdueOffers || [])) {
        const offerStart = new Date(offer.offer_date);
        const offerEnd = new Date(offerStart.getTime() + offer.duration * 60 * 1000);
        // إذا انقضى وقت الدرس الكامل ولم يُبدأ
        if (now > offerEnd) {
            await expireOverdueOffer(offer.id);
        }
    }

    // 2) دروس live/paused تجاوزت grace period (10 دقائق بعد انتهاء وقتها)
    const GRACE_MS = 10 * 60 * 1000;
    const { data: liveOffers } = await supabase
        .from('offers')
        .select('id, offer_date, duration, subject_name')
        .in('status', ['live', 'paused']);

    for (const offer of (liveOffers || [])) {
        const offerStart = new Date(offer.offer_date);
        const offerEnd = new Date(offerStart.getTime() + offer.duration * 60 * 1000);
        const graceEnd = new Date(offerEnd.getTime() + GRACE_MS);

        if (now >= graceEnd) {
            console.log(`⏰ انتهت فترة السماح للبث ${offer.id} (${offer.subject_name}) - يتم الإنهاء الإجباري`);
            await forceEndStream(offer.id, 'grace_timeout');
        }
    }
}

module.exports = {
    verifyJitsiRoom,
    recordStreamStart,
    recordStreamPause,
    recordStreamEnd,
    recordStreamEndWithReason,
    calculateActualStreamDuration,
    verifyStreamCompletion,
    processStreamPayments,
    getStreamVerification,
    expireOverdueOffer,
    forceEndStream,
    checkAndExpireOverdueOffers,
    archiveStreamLog,
    releasePlanSessionEscrow
};
