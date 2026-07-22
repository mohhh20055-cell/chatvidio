const fs = require('fs');
const path = require('path');

const files = [
  'public/index.html',
  'public/student-dashboard.html',
  'public/teacher-dashboard.html',
  'public/admin.html',
  'public/teacher-profile.html'
];

const replacements = [
  // Refined primary palette
  {
    pattern: /--primary:\s*#0f5cbf;\s*--primary-dark:\s*#0b4a9c;\s*--primary-light:\s*#e8f0fe;\s*--primary-gradient:\s*linear-gradient\(135deg,\s*#0f5cbf\s+0%,\s*#1a3a6b\s+100%\);/,
    replacement: `--primary: #1e40af;\n            --primary-dark: #1e3a8a;\n            --primary-light: #eff6ff;\n            --primary-soft: #dbeafe;\n            --primary-gradient: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%);`
  },
  // Refined secondary palette
  {
    pattern: /--secondary:\s*#10b981;\s*--secondary-dark:\s*#059669;\s*--secondary-gradient:\s*linear-gradient\(135deg,\s*#10b981\s+0%,\s*#059669\s+100%\);/,
    replacement: `--secondary: #059669;\n            --secondary-dark: #047857;\n            --secondary-soft: #d1fae5;\n            --secondary-gradient: linear-gradient(135deg, #059669 0%, #10b981 100%);`
  },
  // Refined accent
  {
    pattern: /--accent:\s*#8b5cf6;\s*--accent-light:\s*#ede9fe;/,
    replacement: `--accent: #6366f1;\n            --accent-light: #e0e7ff;\n            --accent-soft: #c7d2fe;`
  },
  // Refined gold
  {
    pattern: /--gold:\s*#f59e0b;\s*--gold-light:\s*#fef3c7;\s*--gold-dark:\s*#d97706;\s*--gold-gradient:\s*linear-gradient\(135deg,\s*#f59e0b\s+0%,\s*#d97706\s+100%\);/,
    replacement: `--gold: #f59e0b;\n            --gold-light: #fffbeb;\n            --gold-dark: #d97706;\n            --gold-soft: #fef3c7;\n            --gold-gradient: linear-gradient(135deg, #f59e0b 0%, #f97316 100%);`
  },
  // Refined danger
  {
    pattern: /--danger:\s*#ef4444;\s*--danger-light:\s*#fef2f2;\s*--danger-gradient:\s*linear-gradient\(135deg,\s*#ef4444\s+0%,\s*#dc2626\s+100%\);/,
    replacement: `--danger: #dc2626;\n            --danger-light: #fef2f2;\n            --danger-soft: #fee2e2;\n            --danger-gradient: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);`
  },
  // Better shadows
  {
    pattern: /--shadow-sm:\s*0\s+1px\s+3px\s+rgba\(0,0,0,0\.04\),\s*0\s+2px\s+8px\s+rgba\(0,0,0,0\.04\);\s*--shadow-md:\s*0\s+4px\s+6px\s+rgba\(0,0,0,0\.03\),\s*0\s+12px\s+24px\s+rgba\(0,0,0,0\.06\);\s*--shadow-lg:\s*0\s+8px\s+16px\s+rgba\(0,0,0,0\.04\),\s*0\s+24px\s+48px\s+rgba\(0,0,0,0\.08\);\s*--shadow-xl:\s*0\s+12px\s+24px\s+rgba\(0,0,0,0\.04\),\s*0\s+32px\s+64px\s+rgba\(0,0,0,0\.1\);/,
    replacement: `--shadow-sm: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04);\n            --shadow-md: 0 4px 6px rgba(0,0,0,0.02), 0 12px 28px rgba(0,0,0,0.06);\n            --shadow-lg: 0 8px 20px rgba(0,0,0,0.04), 0 24px 56px rgba(0,0,0,0.08);\n            --shadow-xl: 0 12px 28px rgba(0,0,0,0.04), 0 32px 72px rgba(0,0,0,0.1);\n            --shadow-inner: inset 0 2px 4px rgba(0,0,0,0.02);`
  },
  // Add surface-warm when not present
  {
    pattern: /--surface-alt:\s*#f8fafc;\s*--border:\s*#e2e8f0;/,
    replacement: `--surface-alt: #f8fafc;\n            --surface-warm: #fafaf9;\n            --border: #e2e8f0;\n            --border-strong: #cbd5e1;`
  },
  // Teacher dashboard specific variables
  {
    pattern: /--gradient-main:\s*linear-gradient\(135deg,\s*#0f5cbf\s+0%,\s*#1e3c72\s+100%\);/,
    replacement: `--gradient-main: linear-gradient(135deg, #1e40af 0%, #2563eb 100%);`
  }
];

let changedCount = 0;

for (const file of files) {
  const fullPath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fullPath)) {
    console.log(`? Skipped: ${file}`);
    continue;
  }
  let content = fs.readFileSync(fullPath, 'utf8');
  const original = content;
  for (const { pattern, replacement } of replacements) {
    if (pattern.test(content)) {
      content = content.replace(pattern, replacement);
    }
  }
  if (content !== original) {
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`? Updated: ${file}`);
    changedCount++;
  } else {
    console.log(`- No change: ${file}`);
  }
}

console.log(`\nDone. Updated ${changedCount} files.`);
