const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function main() {
    const srcPath = path.join(process.cwd(), 'app/src/main/res/drawable/app_logo.png');
    if (!fs.existsSync(srcPath)) {
        console.error('Source image app/src/main/res/drawable/app_logo.png not found!');
        process.exit(1);
    }

    console.log('Using valid source image:', srcPath);
    const imageBuffer = fs.readFileSync(srcPath);

    const targets = [
        // Web assets
        { file: 'public/favicon-48x48.png', width: 48, height: 48 },
        { file: 'public/favicon-96x96.png', width: 96, height: 96 },
        { file: 'public/favicon.ico', width: 48, height: 48 },
        { file: 'public/apple-touch-icon.png', width: 180, height: 180 },
        { file: 'public/images/zoomdz.png', width: 192, height: 192 },
        { file: 'public/images/logo-icon.png', width: 512, height: 512 },
        { file: 'public/images/zoomdz-logo.png', width: 1024, height: 1024 },

        // Android launcher assets (square)
        { file: 'app/src/main/res/mipmap-mdpi/ic_launcher.png', width: 48, height: 48 },
        { file: 'app/src/main/res/mipmap-mdpi/ic_launcher_round.png', width: 48, height: 48 },
        { file: 'app/src/main/res/mipmap-hdpi/ic_launcher.png', width: 72, height: 72 },
        { file: 'app/src/main/res/mipmap-hdpi/ic_launcher_round.png', width: 72, height: 72 },
        { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher.png', width: 96, height: 96 },
        { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher_round.png', width: 96, height: 96 },
        { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png', width: 144, height: 144 },
        { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png', width: 144, height: 144 },
        { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', width: 192, height: 192 },
        { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png', width: 192, height: 192 }
    ];

    for (const target of targets) {
        const fullPath = path.join(process.cwd(), target.file);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Let's use containment to preserve aspect ratio and center on square transparent canvas
        await sharp(imageBuffer)
            .resize(target.width, target.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png({ quality: 100, compressionLevel: 9 })
            .toFile(fullPath);

        // Also update dist/ folder for web files
        if (target.file.startsWith('public/')) {
            const distPath = path.join(process.cwd(), 'dist', target.file.replace('public/', ''));
            const distDir = path.dirname(distPath);
            if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
            fs.copyFileSync(fullPath, distPath);
            console.log(`✅ Generated ${target.file} and copied to dist/`);
        } else {
            console.log(`✅ Generated ${target.file}`);
        }
    }

    console.log('🎉 All assets generated successfully!');
}

main().catch(err => {
    console.error('Error generating assets:', err);
    process.exit(1);
});
