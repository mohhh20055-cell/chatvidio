const fs = require('fs');
const path = require('path');

const files = [
  'public/index.html',
  'public/student-dashboard.html',
  'public/teacher-dashboard.html',
  'public/admin.html',
  'public/teacher-profile.html'
];

const componentImprovements = [
  // Better buttons - less AI-template feel
  {
    file: 'public/teacher-dashboard.html',
    pattern: /\.btn-primary[^}]*}/s,
    replacement: `.btn-primary {
            background: linear-gradient(135deg, #1e40af 0%, #2563eb 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 12px;
            cursor: pointer;
            font-weight: 700;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 8px rgba(30, 64, 175, 0.2);
            font-size: 0.9rem;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(30, 64, 175, 0.35);
        }`
  },
  // Better cards
  {
    file: 'public/index.html',
    pattern: /\.teacher-card[^}]*}/s,
    replacement: `.teacher-card {
            background: #fff;
            border-radius: 20px;
            padding: 24px;
            border: 1px solid #f1f5f9;
            box-shadow: 0 2px 8px rgba(0,0,0,0.04);
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        .teacher-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #1e40af, #3b82f6);
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        .teacher-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 8px 24px rgba(0,0,0,0.08);
            border-color: #dbeafe;
        }
        .teacher-card:hover::before {
            opacity: 1;
        }`
  },
  // Better inputs
  {
    file: 'public/index.html',
    pattern: /input\[type="text"\]\[id\^="login"\]|input\[type="email"\]\[id\^="login"\]|input\[type="password"\]\[id\^="login"\]/,
    replacement: `input[type="text"], input[type="email"], input[type="password"], input[type="tel"], input[type="url"], input[type="number"], select, textarea {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e2e8f0;
            border-radius: 12px;
            font-size: 0.95rem;
            background: #fff;
            transition: all 0.2s ease;
            color: #1e293b;
            font-family: 'Cairo', sans-serif;
        }
        input:focus, select:focus, textarea:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.08);
        }`
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
  
  for (const imp of componentImprovements) {
    if (imp.file === file && imp.pattern.test(content)) {
      content = content.replace(imp.pattern, imp.replacement);
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
