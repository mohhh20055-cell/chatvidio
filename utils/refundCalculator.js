// ============================================================
// دالة موحدة لحساب مبالغ استرداد الحجوزات بدقة تامة
// ============================================================
// 1. استبعاد رسوم المنصة: يسترد الطالب المبلغ بدون رسوم المنصة.
// 2. خصم الحصص المستردة سابقاً: إذا كان قد استرد له مبلغ حصة ضمن خطة،
//    يتم حساب هذا المبلغ ويخصم من الرصيد المسترد الآن لمنع أن يأخذ مبالغ
//    أكبر من القيمة الأصلية لاشتراك العرض.
// 3. حساب المبلغ الفعلي الواجب خصمه من الرصيد المعلق للأستاذ بدقة.
// ============================================================

const { supabase } = require('../config/database');
const logger = require('./logger');

const money = (val) => Math.round((Number(val) || 0) * 100) / 100;

/**
 * @param {Object} params
 * @param {Object} params.session - سجل الجلسة من جدول sessions
 * @param {Object} params.offer - سجل العرض من جدول offers
 * @param {number|string} [params.studentId] - معرف الطالب
 * @returns {Promise<Object>} تفاصيل الاسترداد المالية الدقيقة
 */
async function calculateBookingRefundDetails({ session, offer, studentId }) {
    if (!session || !offer) {
        return {
            totalPaid: 0,
            platformFee: 0,
            baseRefundableWithoutFee: 0,
            previouslyRefunded: 0,
            netRefundAmount: 0,
            teacherDeduction: 0,
            isFree: true,
            subscription: null,
            details: 'بيانات غير كافية'
        };
    }

    const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;
    if (isFree) {
        return {
            totalPaid: 0,
            platformFee: 0,
            baseRefundableWithoutFee: 0,
            previouslyRefunded: 0,
            netRefundAmount: 0,
            teacherDeduction: 0,
            isFree: true,
            subscription: null,
            details: 'العرض مجاني'
        };
    }

    const targetStudentId = studentId ? parseInt(studentId) : parseInt(session.student_id);
    const totalPaid = money(session.payment_amount || 0);

    // جلب اشتراك الطالب في خطة البث إن وجد
    let subscription = null;
    try {
        const { data: sub } = await supabase
            .from('stream_subscriptions')
            .select('*')
            .eq('offer_id', offer.id)
            .eq('student_id', targetStudentId)
            .maybeSingle();
        subscription = sub || null;
    } catch (err) {
        // تجاهل أخطاء Supabase في وضع Mock
    }

    // 1️⃣ حساب رسوم المنصة والمبلغ الأساسي بدون رسوم المنصة
    const totalSessions = parseInt(offer.total_sessions || subscription?.total_sessions) || 1;
    const sessionDuration = parseInt(offer.session_duration || offer.duration) || 60;
    const defaultPlatformFeePerSession = Math.round((sessionDuration / 60) * 50);
    const platformFeePerSession = parseFloat(offer.platform_fee_per_session || subscription?.platform_fee_per_session || defaultPlatformFeePerSession);
    const totalPlatformFee = money(offer.total_platform_fee || (platformFeePerSession * totalSessions));

    let baseRefundableWithoutFee = 0;
    if (session.teacher_earned && parseFloat(session.teacher_earned) > 0) {
        baseRefundableWithoutFee = money(session.teacher_earned);
    } else if (subscription && subscription.teacher_total_escrow && parseFloat(subscription.teacher_total_escrow) > 0) {
        baseRefundableWithoutFee = money(subscription.teacher_total_escrow);
    } else if (offer.total_teacher_price && parseFloat(offer.total_teacher_price) > 0) {
        baseRefundableWithoutFee = money(offer.total_teacher_price);
    } else {
        // إذا لم تكن مسجلة صراحة، نخصم رسوم المنصة من إجمالي ما دفعه الطالب
        baseRefundableWithoutFee = Math.max(0, money(totalPaid - totalPlatformFee));
    }

    // 2️⃣ حساب المبالغ التي استردها الطالب سابقاً عن أي حصة في هذا العرض / الخطة
    let previouslyRefunded = 0;

    // أ) فحص سجل معاملات المحفظة للطالب (wallet_transactions)
    try {
        const { data: txns } = await supabase
            .from('wallet_transactions')
            .select('amount, description')
            .eq('student_id', targetStudentId)
            .eq('type', 'refund')
            .eq('status', 'completed');

        if (txns && txns.length > 0) {
            const subIdStr = subscription?.id ? `اشتراك رقم ${subscription.id}` : null;
            const offerName = offer?.subject_name ? offer.subject_name.trim() : null;

            for (const t of txns) {
                const desc = t.description || '';
                const matchSub = subIdStr && desc.includes(subIdStr);
                const matchOffer = offerName && desc.includes(offerName);
                const isSessionRefund = desc.includes('حصة') || desc.includes('غير مكتملة') || desc.includes('لعدم اكتمالها');

                // احتساب استردادات الحصص فقط مع تجنب عد معاملات الإلغاء الشامل
                if ((matchSub || (matchOffer && isSessionRefund)) && !desc.includes('إلغاء حجز من قبل الأستاذ') && !desc.includes('حذف درس')) {
                    previouslyRefunded += parseFloat(t.amount || 0);
                }
            }
        }
    } catch (err) {
        // تجاهل
    }

    // ب) إذا لم نجد في المحفظة، نتحقق من الحصص المستردة في جدول stream_sessions
    if (previouslyRefunded === 0) {
        try {
            const { data: refundedStreamSessions } = await supabase
                .from('stream_sessions')
                .select('session_number, refund_amount, price_per_session')
                .eq('offer_id', offer.id)
                .eq('status', 'refunded');

            if (refundedStreamSessions && refundedStreamSessions.length > 0) {
                const pricePerSession = parseFloat(offer.price_per_session || subscription?.price_per_session || (baseRefundableWithoutFee / totalSessions));
                previouslyRefunded = refundedStreamSessions.length * pricePerSession;
            } else if (Array.isArray(offer.sessions_schedule)) {
                const refundedSchedule = offer.sessions_schedule.filter(s => s.status === 'refunded');
                if (refundedSchedule.length > 0) {
                    const pricePerSession = parseFloat(offer.price_per_session || subscription?.price_per_session || (baseRefundableWithoutFee / totalSessions));
                    previouslyRefunded = refundedSchedule.length * pricePerSession;
                }
            }
        } catch (err) {
            // تجاهل
        }
    }

    // ج) إذا كانت مسجلة في حقل refunded_amount في session أو subscription
    if (session.refunded_amount && parseFloat(session.refunded_amount) > previouslyRefunded) {
        previouslyRefunded = parseFloat(session.refunded_amount);
    }
    if (subscription?.refunded_amount && parseFloat(subscription.refunded_amount) > previouslyRefunded) {
        previouslyRefunded = parseFloat(subscription.refunded_amount);
    }

    previouslyRefunded = money(previouslyRefunded);

    // 3️⃣ حساب صافي المبلغ المسترد للطالب الآن:
    // المبلغ بدون رسوم المنصة ناقص أي مبالغ حصص تم استردادها سابقاً.
    // يضمن عدم تجاوز المبلغ الأصلي الذي دفعه الطالب بدون رسوم المنصة.
    const netRefundAmount = Math.max(0, money(baseRefundableWithoutFee - previouslyRefunded));

    // 4️⃣ المبلغ الواجب خصمه من الرصيد المعلق للأستاذ:
    // يخصم فقط المبلغ الصافي المسترد حتى لا يتكرر خصم ما تم خصمه سابقاً
    const teacherDeduction = netRefundAmount;

    return {
        totalPaid,
        platformFee: totalPlatformFee,
        baseRefundableWithoutFee,
        previouslyRefunded,
        netRefundAmount,
        teacherDeduction,
        isFree: false,
        subscription,
        details: previouslyRefunded > 0 
            ? `المبلغ الأساسي: ${baseRefundableWithoutFee} دج (بدون رسوم منصة ${totalPlatformFee} دج) - خصم حصص مستردة سابقاً: ${previouslyRefunded} دج = الصافي: ${netRefundAmount} دج`
            : `المبلغ الأساسي: ${baseRefundableWithoutFee} دج (بدون رسوم منصة ${totalPlatformFee} دج)`
    };
}

module.exports = {
    calculateBookingRefundDetails,
    money
};
