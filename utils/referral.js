// ============================================================
// دوال نظام الإحالة
// ============================================================

const { supabase } = require('../config/database');
const { getOne, insert, update } = require('./helpers');

async function processReferralOnRegister(refCode, newUserId, newUserRole) {
    try {
        let referrer = null;
        let referrerRole = null;

        const { data: studentReferrer } = await supabase
            .from('students')
            .select('id, referral_code, full_name')
            .eq('referral_code', refCode)
            .single();

        if (studentReferrer) {
            referrer = studentReferrer;
            referrerRole = 'student';
        } else {
            const { data: teacherReferrer } = await supabase
                .from('teachers')
                .select('id, referral_code, full_name')
                .eq('referral_code', refCode)
                .single();

            if (teacherReferrer) {
                referrer = teacherReferrer;
                referrerRole = 'teacher';
            }
        }

        if (!referrer || referrer.id === newUserId) {
            return;
        }

        await insert('referrals', {
            referrer_id: referrer.id,
            referrer_role: referrerRole,
            referred_user_id: newUserId,
            referred_user_role: newUserRole,
            status: 'pending_verification',
            created_at: new Date().toISOString()
        });

        console.log(`تم تسجيل إحالة: ${referrer.full_name} (${referrerRole}) -> مستخدم جديد`);
    } catch (error) {
        console.error('خطأ في معالجة الإحالة:', error.message);
    }
}

async function processReferralReward(referredUserId, referredUserRole) {
    try {
        const { data: referral } = await supabase
            .from('referrals')
            .select('*')
            .eq('referred_user_id', referredUserId)
            .eq('referred_user_role', referredUserRole)
            .eq('status', 'pending_verification')
            .single();

        if (!referral) {
            console.log('لا توجد إحالة معلقة لهذا المستخدم');
            return false;
        }

        await supabase
            .from('referrals')
            .update({ 
                status: 'completed',
                completed_at: new Date().toISOString()
            })
            .eq('id', referral.id);

        if (referral.referrer_role === 'teacher' && referredUserRole === 'teacher') {
            const teacher = await getOne('teachers', 'id', referral.referrer_id);
            if (teacher) {
                const newBalance = (teacher.referral_balance || 0) + 100;
                await supabase
                    .from('teachers')
                    .update({ 
                        referral_balance: newBalance,
                        balance: (teacher.balance || 0) + 100
                    })
                    .eq('id', referral.referrer_id);

                await insert('referral_rewards', {
                    teacher_id: referral.referrer_id,
                    referred_user_id: referredUserId,
                    referred_user_role: referredUserRole,
                    amount: 100,
                    type: 'balance',
                    description: `مكافأة إحالة أستاذ جديد - تم قبوله من الإدارة`,
                    created_at: new Date().toISOString()
                });

                console.log(`✅ تم إضافة 100 دج للمعلم ${teacher.full_name} فور قبول الأستاذ المحال`);
            }
        }

        if (referral.referrer_role === 'student') {
            console.log(`📌 الطالب المحيل سيحصل على فرصة صندوق هدايا عند حجز المحال درساً مدفوعاً`);
            
            await insert('referral_pending_rewards', {
                referral_id: referral.id,
                referrer_student_id: referral.referrer_id,
                referred_user_id: referredUserId,
                referred_user_role: referredUserRole,
                reward_type: 'gift_box_chance',
                status: 'pending_booking',
                created_at: new Date().toISOString()
            });
        }

        return true;
    } catch (error) {
        console.error('خطأ في معالجة مكافأة الإحالة:', error.message);
        return false;
    }
}

async function processStudentReferralRewardOnBooking(referredUserId, referredUserRole) {
    try {
        const { data: pendingRewards } = await supabase
            .from('referral_pending_rewards')
            .select('*')
            .eq('referred_user_id', referredUserId)
            .eq('referred_user_role', referredUserRole)
            .eq('status', 'pending_booking')
            .limit(1);

        if (!pendingRewards || pendingRewards.length === 0) {
            return false;
        }

        const pendingReward = pendingRewards[0];

        const student = await getOne('students', 'id', pendingReward.referrer_student_id);
        if (student) {
            const newChances = (student.gift_box_chances || 0) + 1;
            await supabase
                .from('students')
                .update({ 
                    gift_box_chances: newChances
                })
                .eq('id', pendingReward.referrer_student_id);

            await insert('referral_rewards', {
                student_id: pendingReward.referrer_student_id,
                referred_user_id: referredUserId,
                referred_user_role: referredUserRole,
                type: 'gift_box_chance',
                description: `فرصة صندوق هدايا - حجز المحال درساً مدفوعاً`,
                created_at: new Date().toISOString()
            });

            await supabase
                .from('referral_pending_rewards')
                .update({ 
                    status: 'completed',
                    completed_at: new Date().toISOString()
                })
                .eq('id', pendingReward.id);

            console.log(`✅ تم منح فرصة صندوق هدايا للطالب ${student.full_name} بعد حجز المحال درساً مدفوعاً`);
            return true;
        }

        return false;
    } catch (error) {
        console.error('خطأ في منح مكافأة الطالب:', error.message);
        return false;
    }
}

module.exports = {
    processReferralOnRegister,
    processReferralReward,
    processStudentReferralRewardOnBooking
};
