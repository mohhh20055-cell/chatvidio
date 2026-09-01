const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function createZoomDzIcon(size) {
    const png = new PNG({ width: size, height: size });

    const cx = size / 2;
    const cy = size / 2;
    const radius = size * 0.44;
    const cornerRadius = size * 0.22;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (size * y + x) << 2;

            // Rounded rectangle mask (Squircle badge)
            const dx = Math.max(0, Math.abs(x - cx) - (cx - cornerRadius));
            const dy = Math.max(0, Math.abs(y - cy) - (cy - cornerRadius));
            const distFromCorner = Math.sqrt(dx * dx + dy * dy);

            if (distFromCorner > cornerRadius) {
                // Transparent background outside badge
                png.data[idx] = 0;
                png.data[idx + 1] = 0;
                png.data[idx + 2] = 0;
                png.data[idx + 3] = 0;
                continue;
            }

            // Antialiasing on border
            let alpha = 255;
            if (distFromCorner > cornerRadius - 1) {
                alpha = Math.floor(255 * (cornerRadius - distFromCorner + 1));
                alpha = Math.max(0, Math.min(255, alpha));
            }

            // Rich Gradient Background: Deep Blue (Top-Left) to Vibrant Cyan (Bottom-Right)
            const factor = (x + y) / (size * 2);
            let r = Math.floor(30 + factor * (37 - 30));    // #1e3a8a -> #2563eb
            let g = Math.floor(58 + factor * (99 - 58));
            let b = Math.floor(138 + factor * (235 - 138));

            // Inner circle ring highlight (#0284c7 / #38bdf8)
            const distFromCenter = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            if (distFromCenter > radius * 0.88 && distFromCenter < radius) {
                r = Math.floor(r * 0.8 + 56 * 0.2);
                g = Math.floor(g * 0.8 + 189 * 0.2);
                b = Math.floor(b * 0.8 + 248 * 0.2);
            }

            // Draw stylized "Z" symbol with video play/camera element
            let isSymbol = false;

            // Normalized coordinates relative to center (-1 to +1)
            const nx = (x - cx) / (size * 0.35);
            const ny = (y - cy) / (size * 0.35);

            // Top horizontal bar of "Z"
            if (ny >= -0.75 && ny <= -0.42 && nx >= -0.7 && nx <= 0.7) {
                isSymbol = true;
            }
            // Bottom horizontal bar of "Z"
            else if (ny >= 0.42 && ny <= 0.75 && nx >= -0.7 && nx <= 0.7) {
                isSymbol = true;
            }
            // Diagonal stroke of "Z"
            else {
                // Equation for diagonal: nx ≈ -ny
                const diagDist = Math.abs(nx + ny);
                if (diagDist < 0.28 && ny >= -0.55 && ny <= 0.55) {
                    isSymbol = true;
                }
            }

            // Play Triangle / Dot in center
            const playX = nx - 0.25;
            const playY = ny + 0.05;
            if (playX >= -0.15 && playX <= 0.25 && Math.abs(playY) <= (0.2 - playX * 0.5)) {
                isSymbol = true;
            }

            if (isSymbol) {
                // Crisp White Symbol with subtle glow
                png.data[idx] = 255;
                png.data[idx + 1] = 255;
                png.data[idx + 2] = 255;
                png.data[idx + 3] = alpha;
            } else {
                png.data[idx] = r;
                png.data[idx + 1] = g;
                png.data[idx + 2] = b;
                png.data[idx + 3] = alpha;
            }
        }
    }

    return PNG.sync.write(png);
}

// Generate all required sizes
const targets = [
    { file: 'public/favicon-48x48.png', size: 48 },
    { file: 'public/favicon-96x96.png', size: 96 },
    { file: 'public/favicon.ico', size: 48 },
    { file: 'public/apple-touch-icon.png', size: 180 },
    { file: 'public/images/zoomdz.png', size: 192 },
    { file: 'public/images/zoomdz-logo.png', size: 512 },
    { file: 'public/images/logo-icon.png', size: 512 },
    { file: 'app/src/main/res/mipmap-mdpi/ic_launcher.png', size: 48 },
    { file: 'app/src/main/res/mipmap-mdpi/ic_launcher_round.png', size: 48 },
    { file: 'app/src/main/res/mipmap-hdpi/ic_launcher.png', size: 72 },
    { file: 'app/src/main/res/mipmap-hdpi/ic_launcher_round.png', size: 72 },
    { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher.png', size: 96 },
    { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher_round.png', size: 96 },
    { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png', size: 144 },
    { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png', size: 144 },
    { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', size: 192 },
    { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png', size: 192 }
];

targets.forEach(target => {
    const fullPath = path.join(process.cwd(), target.file);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const buffer = createZoomDzIcon(target.size);
    fs.writeFileSync(fullPath, buffer);
    console.log(`✅ Generated ${target.file} (${target.size}x${target.size} px, ${buffer.length} bytes)`);
});
