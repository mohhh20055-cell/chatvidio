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
        // التحقق من وجود الغرفة في جدول العروض
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
        console.error('خطأ في التحقق من Jitsi:', error.message);
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
        console.error('خطأ في تسجيل بداية البث:', error.message);
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

    const startTime = new Date(verification.server_start_time);
    const endTime = verification.server_end_time 
        ? new Date(verification.server_end_time) 
        : new Date();
    
    const totalSeconds = Math.floor((endTime - startTime) / 1000);
    
    // حساب وقت الإيقاف الكلي (يمكن تحسينه لاحقاً)
    const pausedSeconds = verification.total_paused_seconds || 0;
    
    // الوقت الفعلي للبث = الوقت الكلي - وقت الإيقاف
    const actualLiveSeconds = Math.max(0, totalSeconds - pausedSeconds);

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
        .select('id, duration, teacher_id, subject_name, price')
        .eq('id', offerId)
        .single();

    if (offerError || !offer) {
        return { complete: false, error: 'العرض غير موجود' };
    }

    const verification = await calculateActualStreamDuration(offerId);
    
    if (!verification) {
        return { complete: false, error: 'لا توجد بيانات تحقق' };
    }

    const expectedDuration = offer.duration * 60; // بالدقائق إلى ثواني
    const actualDuration = verification.actual_live_seconds;
    const completionPercentage = (actualDuration / expectedDuration) * 100;

    return {
        complete: completionPercentage >= 80, // 80% من الوقت المطلوب
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
        .select('id, teacher_id, price, subject_name, is_free')
        .eq('id', offerId)
        .single();

    if (offerError || !offer) {
        console.error('خطأ في جلب العرض:', offerError);
        return;
    }

    // إذا كان مجانياً، لا حاجة للمعالجة
    if (offer.is_free || offer.price === 0) {
        console.log('العرض مجاني، لا حاجة لمعالجة المدفوعات');
        return;
    }

    // جلب جميع الجلسات المعلقة لهذا العرض
    const { data: sessions, error: sessionsError } = await supabase
        .from('sessions')
        .select('id, student_id, payment_amount, payment_status')
        .eq('offer_id', offerId)
        .eq('payment_status', 'pending_stream');

    if (sessionsError) {
        console.error('خطأ في جلب الجلسات:', sessionsError);
        return;
    }

    console.log(`📊 جاري معالجة ${sessions?.length || 0} جلسة للبث ${offerId}`);

    for (const session of (sessions || [])) {
        if (completion.complete) {
            // البث مكتمل - دفع كامل للأستاذ
            
            // تحديث حالة الجلسة
            await supabase
                .from('sessions')
                .update({
                    payment_status: 'paid',
                    teacher_earned: session.payment_amount,
                    completed_at: new Date().toISOString()
                })
                .eq('id', session.id);

            // إضافة للأستاذ
            const { data: teacher } = await supabase
                .from('teachers')
                .select('pending_withdraw, total_earned')
                .eq('id', offer.teacher_id)
                .single();

            await supabase
                .from('teachers')
                .update({
                    pending_withdraw: Math.max(0, (teacher?.pending_withdraw || 0) - session.payment_amount),
                    total_earned: (teacher?.total_earned || 0) + session.payment_amount
                })
                .eq('id', offer.teacher_id);

            console.log(`✅ تم تحويل ${session.payment_amount} دج للأستاذ (بث مكتمل)`);

        } else {
            // البث غير مكتمل - دفع جزئي أو استرداد
            
            const paymentRatio = completion.completion_percentage / 100;
            const teacherAmount = Math.floor(session.payment_amount * paymentRatio);
            const refundAmount = session.payment_amount - teacherAmount;

            if (teacherAmount > 0) {
                // دفع نسبة للمبلغ للأستاذ
                await supabase
                    .from('sessions')
                    .update({
                        payment_status: 'paid',
                        teacher_earned: teacherAmount,
                        completed_at: new Date().toISOString(),
                        partial_payment_note: `دفع جزئي ${Math.round(completion.completion_percentage)}% - ${completion.shortfall_seconds} ثانية ناقصة`
                    })
                    .eq('id', session.id);

                const { data: teacher } = await supabase
                    .from('teachers')
                    .select('pending_withdraw')
                    .eq('id', offer.teacher_id)
                    .single();

                await supabase
                    .from('teachers')
                    .update({
                        pending_withdraw: Math.max(0, (teacher?.pending_withdraw || 0) - session.payment_amount),
                        total_earned: (teacher?.total_earned || 0) + teacherAmount
                    })
                    .eq('id', offer.teacher_id);

                console.log(`⚠️ دفع جزئي ${teacherAmount} دج (${Math.round(completion.completion_percentage)}%) للأستاذ`);
            }

            if (refundAmount > 0) {
                // استرداد الباقي للطالب
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
                        description: `استرداد ${refundAmount} دج - البث كان ${Math.round(completion.completion_percentage)}% مكتمل فقط`,
                        created_at: new Date().toISOString()
                    });

                console.log(`💰 تم استرداد ${refundAmount} دج للطالب`);

                // إشعار الطالب
                await supabase
                    .from('notifications')
                    .insert({
                        user_id: session.student_id,
                        user_type: 'student',
                        title: '💰 استرداد جزئي',
                        message: `تم استرداد ${refundAmount} دج لباقي حصة "${offer.subject_name}" بسبب عدم اكتمال البث (${Math.round(completion.completion_percentage)}% فقط)`,
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
                message: `تم إنهاء البث "${offer.subject_name}". نسبة الاكتمال: ${Math.round(completion.completion_percentage)}%`,
                is_read: false,
                created_at: new Date().toISOString()
            });
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
        console.error('خطأ في جلب العرض للاسترداد:', offerError);
        return;
    }

    // إذا كان مجانياً، لا حاجة للمعالجة
    if (offer.is_free || offer.price === 0) {
        console.log('العرض مجاني، لا حاجة لمعالجة الاسترداد');
        return;
    }

    // جلب جميع الجلسات المعلقة
    const { data: sessions, error: sessionsError } = await supabase
        .from('sessions')
        .select('id, student_id, payment_amount, payment_status')
        .eq('offer_id', offerId)
        .eq('payment_status', 'pending_stream');

    if (sessionsError) {
        console.error('خطأ في جلب الجلسات:', sessionsError);
        return;
    }

    console.log(`⚠️ معالجة إنهاء مبكر للبث ${offerId} - استرداد كامل للطلاب`);

    for (const session of (sessions || [])) {
        // استرداد كامل للمبلغ للطالب
        const { data: student } = await supabase
            .from('students')
            .select('wallet_balance')
            .eq('id', session.student_id)
            .single();

        await supabase
            .from('students')
            .update({
                wallet_balance: (student?.wallet_balance || 0) + session.payment_amount
            })
            .eq('id', session.student_id);

        // تحديث حالة الجلسة
        await supabase
            .from('sessions')
            .update({
                payment_status: 'refunded',
                teacher_earned: 0,
                completed_at: new Date().toISOString(),
                partial_payment_note: 'استرداد كامل - أنهى الأستاذ البث مبكراً'
            })
            .eq('id', session.id);

        // تسجيل المعاملة
        await supabase
            .from('wallet_transactions')
            .insert({
                student_id: session.student_id,
                amount: session.payment_amount,
                type: 'refund',
                status: 'completed',
                description: `استرداد كامل ${session.payment_amount} دج - أنهى الأستاذ البث مبكراً`,
                created_at: new Date().toISOString()
            });

        // إشعار الطالب
        await supabase
            .from('notifications')
            .insert({
                user_id: session.student_id,
                user_type: 'student',
                title: '💰 استرداد كامل',
                message: `تم استرداد ${session.payment_amount} دج لحصة "${offer.subject_name}" لأن الأستاذ أنهى البث مبكراً`,
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

module.exports = {
    verifyJitsiRoom,
    recordStreamStart,
    recordStreamPause,
    recordStreamEnd,
    calculateActualStreamDuration,
    verifyStreamCompletion,
    processStreamPayments,
    getStreamVerification
};
