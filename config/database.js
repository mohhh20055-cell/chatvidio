// ============================================================
// تهيئة قاعدة البيانات - Supabase
// ============================================================

// دعم WebSocket على Node.js < 22 (يحتاجه Supabase realtime-js)
if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase;

if (!supabaseUrl || !supabaseKey) {
    console.warn('[AI Studio] Supabase credentials missing — using mock client');

    const mockDataMap = {
        posts: [
            {
                id: 1,
                title: 'مرحباً بكم في منصة ZoomDz التعليمية!',
                content: 'يسعدنا جداً انضمامكم إلينا. هذه منصة تفاعلية متكاملة تجمع بين الأساتذة والطلاب لتقديم أفضل تجربة تعليمية في الجزائر 🇩🇿. ترقبوا دروساً تفاعلية وبثاً مباشراً لأفضل الأساتذة قريباً!',
                teacher_id: 1,
                created_at: new Date().toISOString(),
                likes_count: 5,
                comments_count: 2,
                user_liked: false,
                image_url: '[]'
            },
            {
                id: 2,
                title: 'نصائح هامة للتحضير للامتحانات والشهادات الرسمية',
                content: 'النجاح يبدأ بخطوة، والتحضير الجيد هو المفتاح. ننصح جميع طلابنا بتنظيم وقتهم ومتابعة الدروس أولاً بأول. الأساتذة هنا لمساعدتكم والإجابة على كل استفساراتكم.',
                teacher_id: 2,
                created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
                likes_count: 12,
                comments_count: 4,
                user_liked: true,
                image_url: '[]'
            }
        ],
        teachers: [
            {
                id: 1,
                full_name: 'الأستاذ أحمد بلال',
                specialization: 'الرياضيات - طور ثانوي',
                experience: 'أكثر من 10 سنوات في التعليم الثانوي والتحضير لشهادة البكالوريا.',
                bio: 'مدرس مادة الرياضيات حريص على تبسيط المفاهيم الصعبة للطلاب.',
                profile_image: '',
                profile_url: '/images/default-avatar.svg',
                teaching_level: 'secondary_all',
                status: 'approved',
                is_banned: false
            },
            {
                id: 2,
                full_name: 'الأستاذة مريم بن عودة',
                specialization: 'العلوم الطبيعية - طور متوسط',
                experience: 'خبرة طويلة في تدريس مادة العلوم الطبيعية وتحضير شهادة التعليم المتوسط (BEM).',
                bio: 'مدرسة مادة العلوم الطبيعية والحياة، شغوفة بتبسيط العلوم.',
                profile_image: '',
                profile_url: '/images/default-avatar.svg',
                teaching_level: 'middle_all',
                status: 'approved',
                is_banned: false
            }
        ],
        students: [
            {
                id: 1,
                full_name: 'ياسين بن علي',
                grade: 'ثالثة ثانوي (BAC)',
                education_level: '3eme_as',
                wilaya: 'الجزائر العاصمة',
                profile_image: '',
                profile_url: '/images/default-avatar.svg',
                is_banned: false
            },
            {
                id: 2,
                full_name: 'سارة مرابط',
                grade: 'رابعة متوسط (BEM)',
                education_level: '4eme_am',
                wilaya: 'وهران',
                profile_image: '',
                profile_url: '/images/default-avatar.svg',
                is_banned: false
            }
        ],
        offers: [
            {
                id: 101,
                teacher_id: 1,
                subject_name: 'مراجعة شاملة لدرس المتتاليات العددية',
                duration: 60,
                offer_date: new Date(Date.now() + 3600000 * 24).toISOString(),
                price: 500,
                is_free: false,
                status: 'approved',
                education_level: '3eme_as',
                booked_count: 15
            }
        ],
        courses: [
            {
                id: 201,
                title: 'دورة التحضير المكثف لشهادة البكالوريا - فيزياء',
                description: 'دورة شاملة تغطي كافة الوحدات مع حلول تمارين نموذجية وامتحانات سابقة.',
                price: 1500,
                teacher_id: 1,
                status: 'published',
                created_at: new Date().toISOString()
            }
        ],
        blogs: [
            {
                id: 1,
                title: 'دليلك الشامل للتفوق في شهادة البكالوريا 2026',
                slug: 'دليلك-الشامل-للتفوق-في-شهادة-البكالوريا',
                excerpt: 'أفضل النصائح والاستراتيجيات الدراسية لتحقيق معدل ممتاز في شهادة البكالوريا في الجزائر.',
                content: '<h2>مقدمة حول التحضير للباكالوريا</h2><p>يعتبر امتحان شهادة البكالوريا محطة حاسمة في مسار كل طالب جزائري. يتطلب النجاح تخطيطاً دกيقاً، ومتابعة مستمرة للدروس، والاعتماد على منصات موثوقة مثل ZoomDz.</p><h2>نصائح عملية للتفوق</h2><ul><li>تنظيم جدول وقت يومي دقيق.</li><li>حل مواضيع البكالوريا السابقة (الأنامال).</li><li>الاستعانة بنخبة الأساتذة عبر منصة ZoomDz.</li></ul>',
                cover_image: '',
                seo_keywords: 'باكالوريا, 2026, نجاح, دراسة, الجزائر, رياضيات, علوم',
                meta_description: 'دليلك الشامل للتفوق في شهادة البكالوريا في الجزائر مع نصائح ذهبية وأفضل استراتيجيات الدراسة والمراجعة.',
                author: 'إدارة ZoomDz',
                created_at: new Date().toISOString()
            }
        ]
    };

    const createMockChain = (tableName) => {
        let mockData = mockDataMap[tableName] || [];
        let isSingle = false;

        const chainObj = {};
        const proxy = new Proxy(chainObj, {
            get(target, prop) {
                if (prop === 'then') {
                    const resultData = isSingle ? (Array.isArray(mockData) ? mockData[0] : mockData) : mockData;
                    return (resolve) => resolve({ data: resultData, error: null });
                }
                if (prop === 'single') {
                    isSingle = true;
                    return () => proxy;
                }
                // Return proxy to support infinite fluent method chaining
                return (...args) => proxy;
            }
        });
        return proxy;
    };

    const mockClient = {
        from: (tableName) => createMockChain(tableName),
        auth: {
            getUser: async () => ({ data: { user: null }, error: null }),
            signInWithPassword: async () => ({ data: { user: null }, error: null }),
            signOut: async () => ({ error: null }),
        },
        storage: {
            from: () => ({
                upload: async () => ({ data: null, error: null }),
                getPublicUrl: () => ({ data: { publicUrl: '' } }),
                remove: async () => ({ data: null, error: null }),
            }),
        }
    };

    // Main Supabase client proxy to handle anything else elegantly
    supabase = new Proxy(mockClient, {
        get: (target, prop) => {
            if (prop in target) return target[prop];
            return () => mockClient;
        }
    });
} else {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
    } catch (e) {
        console.warn('[AI Studio] Failed to initialize Supabase — using mock client', e.message);
        supabase = new Proxy({}, { get: () => () => ({ data: null, error: null }) });
    }
}

module.exports = {
    supabase
};
