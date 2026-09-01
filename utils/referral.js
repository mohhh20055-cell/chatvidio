const logger = require('./logger');
// ============================================================
// دوال نظام الإحالة
// ============================================================

const { supabase } = require('../config/database');
const { getOne, insert, update } = require('./helpers');

async function processReferralOnRegister(refCode, newUserId, newUserRole) {
    try {
        if (!refCode) return;
        const cleanRef = String(refCode).trim();
        if (!cleanRef || cleanRef.length < 3) return;

        let referrer = null;
        let referrerRole = null;

        const { data: studentReferrer } = await supabase
            .from('students')
            .select('id, referral_code, full_name')
            .ilike('referral_code', cleanRef)
            .maybeSingle();

        if (studentReferrer) {
            referrer = studentReferrer;
            referrerRole = 'student';
        } else {
            const { data: teacherReferrer } = await supabase
                .from('teachers')
                .select('id, referral_code, full_name')
                .ilike('referral_code', cleanRef)
                .maybeSingle();

            if (teacherReferrer) {
                referrer = teacherReferrer;
                referrerRole = 'teacher';
            }
        }

        if (!referrer || (referrer.id === newUserId && referrerRole === newUserRole)) {
            return;
        }

        // Check if referral already exists
        const { data: existingRef } = await supabase
            .from('referrals')
            .select('id')
            .eq('referred_user_id', newUserId)
            .eq('referred_user_role', newUserRole)
            .maybeSingle();

        if (existingRef) {
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

        console.log(`✅ تم تسجيل إحالة بنجاح: ${referrer.full_name} (${referrerRole}) -> مستخدم جديد (${newUserRole} ID: ${newUserId})`);
    } catch (error) {
        logger.error('خطأ في معالجة الإحالة:', error.message);
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
                // Weighted reward between 10 and 50 DZD (Biased heavily towards 10 and 20 to protect platform economy)
                const randVal = Math.random() * 100;
                let randomAmount = 10;
                if (randVal < 60) {
                    // 60% chance: 10 to 15 DZD
                    randomAmount = Math.floor(Math.random() * (15 - 10 + 1)) + 10;
                } else if (randVal < 85) {
                    // 25% chance: 16 to 25 DZD (centered around 20 DZD)
                    randomAmount = Math.floor(Math.random() * (25 - 16 + 1)) + 16;
                } else if (randVal < 95) {
                    // 10% chance: 26 to 40 DZD
                    randomAmount = Math.floor(Math.random() * (40 - 26 + 1)) + 26;
                } else {
                    // 5% chance: 41 to 50 DZD
                    randomAmount = Math.floor(Math.random() * (50 - 41 + 1)) + 41;
                }
                const newBalance = (teacher.referral_balance || 0) + randomAmount;
                await supabase
                    .from('teachers')
                    .update({ 
                        referral_balance: newBalance,
                        balance: (teacher.balance || 0) + randomAmount
                    })
                    .eq('id', referral.referrer_id);

                await insert('referral_rewards', {
                    teacher_id: referral.referrer_id,
                    referred_user_id: referredUserId,
                    referred_user_role: referredUserRole,
                    amount: randomAmount,
                    type: 'balance',
                    description: `مكافأة إحالة أستاذ جديد - تم قبوله من الإدارة`,
                    created_at: new Date().toISOString()
                });

                console.log(`✅ تم إضافة ${randomAmount} دج للمعلم ${teacher.full_name} فور قبول الأستاذ المحال`);
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
        logger.error('خطأ في معالجة مكافأة الإحالة:', error.message);
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
        logger.error('خطأ في منح مكافأة الطالب:', error.message);
        return false;
    }
}

module.exports = {
    processReferralOnRegister,
    processReferralReward,
    processStudentReferralRewardOnBooking
};
