// ============================================================
// نظام التحقق الموحد وإلغاء حجز الطالب واسترداد المبالغ بدقة
// ============================================================
// القواعد المعتمدة:
// 1. يظهر ويُحتسب المبلغ المدفوع بدون رسوم المنصة (مثلاً 1000 دج بدلاً من 1200 دج).
// 2. إذا لم يدرس الطالب أي حصة وقام الأستاذ بإلغاء حجزه، يسترد الطالب المبلغ الإجمالي
//    للاشتراك بدون رسوم المنصة (1000 دج)، ويُخصم من الرصيد المعلق للأستاذ.
// 3. الاسترداد والإلغاء من قبل الأستاذ يكون فقط *قبل بدء الحصص*.
//    إذا بدأت الحصة أو درس الطالب حصة أو أكثر ضمن الخطة (حتى وإن لم تكتمل)،
//    فلن يتمكن الأستاذ نهائياً من إلغاء حجز الطالب.
// ============================================================

const { supabase } = require('../config/database');
const logger = require('./logger');

const money = (val) => Math.round((Number(val) || 0) * 100) / 100;

/**
 * التحقق مما إذا كانت حصص الدرس قد بدأت أو عُقدت/دُرست أي حصة ضمن الخطة
 * @param {Object} params
 * @param {Object} params.offer - سجل الدرس
 * @param {Object} [params.session] - سجل جلسة الطالب
 * @param {number|string} [params.studentId] - معرف الطالب
 * @returns {Promise<{ hasStarted: boolean, reason: string }>}
 */
async function hasOfferSessionsStarted({ offer, session, studentId }) {
    if (!offer) return { hasStarted: false, reason: '' };

    // 1. التحقق من حالة الدرس العامة إذا كان جارياً أو مكتملاً أو منتهياً
    if (['live', 'completed', 'ended'].includes(offer.status)) {
        return { hasStarted: true, reason: 'الدرس جارٍ حالياً أو مكتمل' };
    }

    if (offer.stream_active === true || offer.is_live === true || Boolean(offer.stream_started_at)) {
        return { hasStarted: true, reason: 'البث المباشر للدرس قد بدأ بالفعل' };
    }

    // 2. التحقق من عداد الحصص المكتملة
    const completedCount = Number(offer.completed_sessions_count ?? offer.completed_sessions ?? 0);
    if (completedCount > 0) {
        return { hasStarted: true, reason: `تم إكمال ${completedCount} حصة من الدرس` };
    }

    // 3. التحقق من جدول الحصص الفردية stream_sessions
    try {
        const { data: streamSessions } = await supabase
            .from('stream_sessions')
            .select('id, session_number, status, is_escrow_released, refund_amount')
            .eq('offer_id', offer.id);

        if (streamSessions && streamSessions.length > 0) {
            const startedSession = streamSessions.find(s =>
                ['in_progress', 'live', 'completed', 'ended', 'refunded'].includes(s.status) ||
                s.is_escrow_released === true ||
                parseFloat(s.refund_amount || 0) > 0
            );
            if (startedSession) {
                return { hasStarted: true, reason: `الحصة رقم ${startedSession.session_number || ''} قد بدأت أو تمت تسويتها` };
            }
        }
    } catch (err) {
        // ignore error in mock mode
    }

    // 4. التحقق من جدول المواعيد في offer.sessions_schedule
    if (Array.isArray(offer.sessions_schedule)) {
        const startedSched = offer.sessions_schedule.find(s =>
            ['completed', 'in_progress', 'refunded', 'ended'].includes(s.status) ||
            s.is_completed === true
        );
        if (startedSched) {
            return { hasStarted: true, reason: `الحصة (${startedSched.title || startedSched.session_number || ''}) قد بدأت أو اكتملت` };
        }
    }

    // 5. التحقق من جلسة الطالب ذاتها إذا كان قد تم تحرير جزء من مستحقاتها أو استرداد حصة منها
    if (session) {
        if (parseFloat(session.refunded_amount || 0) > 0) {
            return { hasStarted: true, reason: 'تمت معالجة استرداد لحصة سابقة للطالب ضمن هذا الاشتراك' };
        }
        if (session.is_escrow_released === true) {
            return { hasStarted: true, reason: 'تم تحرير مستحقات حصة من هذا الحجز مسبقاً' };
        }
    }

    // 6. التحقق من سجل اشتراك الطالب في جدول stream_subscriptions
    const targetStudentId = studentId ? parseInt(studentId) : (session?.student_id ? parseInt(session.student_id) : null);
    if (targetStudentId) {
        try {
            const { data: sub } = await supabase
                .from('stream_subscriptions')
                .select('id, completed_sessions, refunded_amount, teacher_released_so_far')
                .eq('offer_id', offer.id)
                .eq('student_id', targetStudentId)
                .maybeSingle();

            if (sub) {
                if (Number(sub.completed_sessions || 0) > 0) {
                    return { hasStarted: true, reason: 'الطالب درس حصة أو أكثر ضمن الخطة' };
                }
                if (parseFloat(sub.refunded_amount || 0) > 0) {
                    return { hasStarted: true, reason: 'تم تسجيل استرداد لحصة سابقة لهذا الطالب' };
                }
                if (parseFloat(sub.teacher_released_so_far || 0) > 0) {
                    return { hasStarted: true, reason: 'تم تحرير مستحقات حصص سابقة للأستاذ' };
                }
            }
        } catch (err) {
            // ignore
        }
    }

    // 7. التحقق من سجلات التحقق من البث stream_verification
    try {
        const { data: verifs } = await supabase
            .from('stream_verification')
            .select('id, status')
            .eq('offer_id', offer.id)
            .limit(1);

        if (verifs && verifs.length > 0) {
            return { hasStarted: true, reason: 'تم تسجيل بدء بث للدرس مسبقاً' };
        }
    } catch (err) {
        // ignore
    }

    return { hasStarted: false, reason: '' };
}

/**
 * حساب تفاصيل إلغاء حجز الطالب والمبلغ المسترد بدون رسوم المنصة
 * @param {Object} params
 * @param {Object} params.session - سجل الجلسة من sessions
 * @param {Object} params.offer - سجل الدرس من offers
 * @param {number|string} [params.studentId] - معرف الطالب
 * @returns {Promise<Object>} تفاصيل الإلغاء والاسترداد
 */
async function calculateBookingRefundDetails({ session, offer, studentId }) {
    if (!session || !offer) {
        return {
            totalPaid: 0,
            platformFee: 0,
            amountWithoutFee: 0,
            netRefundAmount: 0,
            teacherDeduction: 0,
            isFree: true,
            hasStarted: false,
            canCancel: false,
            previouslyRefunded: 0,
            baseRefundableWithoutFee: 0,
            reason: 'بيانات غير كافية'
        };
    }

    const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;
    const totalPaid = money(session.payment_amount || 0);

    // حساب المبلغ بدون رسوم المنصة (نصيب الأستاذ)
    let amountWithoutFee = 0;
    let totalPlatformFee = 0;

    if (isFree) {
        amountWithoutFee = 0;
        totalPlatformFee = 0;
    } else {
        const totalSessions = parseInt(offer.total_sessions) || 1;
        const sessionDuration = parseInt(offer.session_duration || offer.duration) || 60;
        const defaultPlatformFeePerSession = Math.round((sessionDuration / 45) * 50);
        const platformFeePerSession = parseFloat(offer.platform_fee_per_session || defaultPlatformFeePerSession);
        totalPlatformFee = money(offer.total_platform_fee || (platformFeePerSession * totalSessions));

        if (session.teacher_earned && parseFloat(session.teacher_earned) > 0) {
            amountWithoutFee = money(session.teacher_earned);
        } else if (offer.total_teacher_price && parseFloat(offer.total_teacher_price) > 0) {
            amountWithoutFee = money(offer.total_teacher_price);
        } else if (offer.price && parseFloat(offer.price) > 0) {
            amountWithoutFee = money(offer.price);
        } else {
            amountWithoutFee = Math.max(0, money(totalPaid - totalPlatformFee));
        }
    }

    // التحقق هل بدأت الحصص أو درس الطالب أي حصة
    const { hasStarted, reason } = await hasOfferSessionsStarted({ offer, session, studentId });
    const canCancel = !hasStarted;

    return {
        totalPaid,
        platformFee: totalPlatformFee,
        amountWithoutFee,
        baseRefundableWithoutFee: amountWithoutFee,
        // الاسترداد متاح فقط قبل بدء الحصص وبالمبلغ الإجمالي بدون رسوم المنصة
        netRefundAmount: canCancel ? amountWithoutFee : 0,
        teacherDeduction: canCancel ? amountWithoutFee : 0,
        previouslyRefunded: 0, // دائماً صفر لعدم وجود حصص قد عُقدت قبل بدء الدرس!
        isFree,
        hasStarted,
        canCancel,
        reason: hasStarted
            ? (reason || 'لا يمكن إلغاء حجز الطالب بعد بدء الحصص أو حضور أي حصة ضمن الخطة')
            : 'يمكن إلغاء الحجز واسترداد المبلغ كاملاً بدون رسوم المنصة'
    };
}

module.exports = {
    hasOfferSessionsStarted,
    calculateBookingRefundDetails,
    money
};
