const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function processUploadedLogo() {
    const srcPath = path.join(process.cwd(), 'public/images/zoomdz-logo.png');
    if (!fs.existsSync(srcPath)) {
        console.error('Source image public/images/zoomdz-logo.png not found!');
        process.exit(1);
    }

    console.log('Processing user uploaded logo from GitHub:', srcPath);

    // Temp buffer to read the original uploaded image
    const imageBuffer = fs.readFileSync(srcPath);

    const targets = [
        { file: 'public/favicon-48x48.png', width: 48, height: 48 },
        { file: 'public/favicon-96x96.png', width: 96, height: 96 },
        { file: 'public/favicon.ico', width: 48, height: 48 },
        { file: 'public/apple-touch-icon.png', width: 180, height: 180 },
        { file: 'public/images/zoomdz.png', width: 192, height: 192 },
        { file: 'public/images/logo-icon.png', width: 512, height: 512 }
    ];

    for (const target of targets) {
        const fullPath = path.join(process.cwd(), target.file);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        await sharp(imageBuffer)
            .resize(target.width, target.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png({ quality: 100, compressionLevel: 9 })
            .toFile(fullPath);

        const distPath = path.join(process.cwd(), 'dist', target.file.replace('public/', ''));
        const distDir = path.dirname(distPath);
        if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
        fs.copyFileSync(fullPath, distPath);

        const stats = fs.statSync(fullPath);
        console.log(`✅ Generated ${target.file} (${target.width}x${target.height} px, ${stats.size} bytes)`);
    }

    // Convert zoomdz-logo.png itself into a pristine 1024x1024 PNG if needed or keep high quality 512x512 PNG
    const logoPngPath = path.join(process.cwd(), 'public/images/zoomdz-logo.png');
    const pngBuffer = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ quality: 100, compressionLevel: 9 })
        .toBuffer();

    fs.writeFileSync(logoPngPath, pngBuffer);
    const logoDistPath = path.join(process.cwd(), 'dist/images/zoomdz-logo.png');
    if (!fs.existsSync(path.dirname(logoDistPath))) fs.mkdirSync(path.dirname(logoDistPath), { recursive: true });
    fs.writeFileSync(logoDistPath, pngBuffer);

    console.log('✅ Updated public/images/zoomdz-logo.png as high quality PNG');
    console.log('All favicons and branding files processed from user uploaded logo!');
}

processUploadedLogo().catch(err => {
    console.error('Error processing uploaded logo:', err);
    process.exit(1);
});
