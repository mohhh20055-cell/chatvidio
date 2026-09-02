const fs = require('fs');
let code = fs.readFileSync('routes/public.js', 'utf8');
code = code.replace(/supabase\s*\.from\('teachers'\)\s*\.select\('\*', \{ count: 'exact', head: true \}\)\s*\.eq\('status', 'approved'\)\s*,/, "supabase.from('teachers').select('*', { count: 'exact', head: true }).eq('status', 'approved').eq('is_banned', false),");
code = code.replace(/supabase\s*\.from\('students'\)\s*\.select\('\*', \{ count: 'exact', head: true \}\)\s*,/, "supabase.from('students').select('*', { count: 'exact', head: true }),");
fs.writeFileSync('routes/public.js', code);
