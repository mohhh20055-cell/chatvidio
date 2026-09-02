const fs = require('fs');
let code = fs.readFileSync('routes/offer.js', 'utf8');

const regex = /if\s*\(insertError\)\s*\{\s*\/\/\s*في حال عدم وجود الأعمدة الجديدة بعد في جدول offers، نقوم بالإدخال بالأعمدة الأساسية كإجراء احتياطي آمن[\s\S]*?insertedOffer\s*=\s*\{\s*\.\.\.fbData,\s*\.\.\.newOffer,\s*id:\s*fbData\.id\s*\};\s*\}\s*else\s*\{\s*insertedOffer\s*=\s*dbOffer;\s*\}/;

const replacement = `if (insertError) {
            console.error('❌ خطأ في إدخال الدرس:', insertError);
            return res.status(500).json({ 
                success: false, 
                error: 'الرجاء تحديث قاعدة البيانات وتشغيل كود SQL الخاص بالاشتراكات (schema_stream_subscription_plans.sql) في Supabase.' 
            });
        }
        
        insertedOffer = dbOffer;`;

if (regex.test(code)) {
    code = code.replace(regex, replacement);
    fs.writeFileSync('routes/offer.js', code);
    console.log("Patched successfully");
} else {
    console.log("Regex did not match");
}
