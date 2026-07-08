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

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ خطأ: متغيرات Supabase غير موجودة');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = {
    supabase
};
