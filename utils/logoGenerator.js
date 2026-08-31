const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('./logger');

/**
 * Downloads or reads an image from a URL or local file path into a Buffer.
 */
async function getImageBuffer(inputPath) {
    if (!inputPath) {
        throw new Error('No input path provided');
    }

    // 1. If it's a base64 Data URL
    if (inputPath.startsWith('data:')) {
        const matches = inputPath.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            throw new Error('Invalid base64 data URL');
        }
        return Buffer.from(matches[2], 'base64');
    }

    // 2. If it's a local relative path (starts with /uploads or uploads)
    if (inputPath.startsWith('/uploads') || inputPath.startsWith('uploads')) {
        const cleanPath = inputPath.startsWith('/') ? inputPath.slice(1) : inputPath;
        // Search in public/ folder first, then project root
        let localPath = path.join(process.cwd(), 'public', cleanPath);
        if (!fs.existsSync(localPath)) {
            localPath = path.join(process.cwd(), cleanPath);
        }
        if (fs.existsSync(localPath)) {
            return fs.readFileSync(localPath);
        }
    }

    // 3. If it's a remote URL (HTTP/HTTPS)
    if (inputPath.startsWith('http://') || inputPath.startsWith('https://')) {
        try {
            const response = await fetch(inputPath);
            if (!response.ok) {
                throw new Error(`Failed to fetch image from URL: ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (fetchErr) {
            logger.error(`[LogoGenerator] Error fetching remote URL ${inputPath}:`, fetchErr.message);
            throw fetchErr;
        }
    }

    // 4. Default fallback: try to read it as a direct absolute or relative file path on disk
    try {
        let directPath = inputPath;
        if (!path.isAbsolute(directPath)) {
            directPath = path.join(process.cwd(), inputPath);
        }
        if (fs.existsSync(directPath)) {
            return fs.readFileSync(directPath);
        }
    } catch (e) {}

    throw new Error(`Unable to resolve image source: ${inputPath}`);
}

/**
 * Regenerates all web favicons, platform icons, and Android mipmap assets from a single logo image.
 */
async function regenerateLogo(logoUrlOrPath) {
    try {
        logger.info(`[LogoGenerator] Starting logo regeneration from source: ${logoUrlOrPath}`);
        const imageBuffer = await getImageBuffer(logoUrlOrPath);

        const targets = [
            // Web branding assets (source and dist)
            { file: 'public/favicon-48x48.png', width: 48, height: 48, contain: true },
            { file: 'public/favicon-96x96.png', width: 96, height: 96, contain: true },
            { file: 'public/favicon.ico', width: 48, height: 48, contain: true },
            { file: 'public/apple-touch-icon.png', width: 180, height: 180, contain: true },
            { file: 'public/images/zoomdz.png', width: 192, height: 192, contain: true },
            { file: 'public/images/logo-icon.png', width: 512, height: 512, contain: true },
            { file: 'public/images/zoomdz-logo.png', width: 1024, height: 1024, contain: true },

            // Android master drawable icons (aspect ratio centered inside transparent canvas)
            { file: 'app/src/main/res/drawable/app_logo.png', width: 360, height: 512, contain: true },
            { file: 'app/src/main/res/drawable/ic_logo_img.png', width: 360, height: 512, contain: true },
            { file: 'app/src/main/res/drawable-nodpi/app_logo.png', width: 360, height: 512, contain: true },

            // Android mipmap launchers (square/round icons)
            { file: 'app/src/main/res/mipmap-mdpi/ic_launcher.png', width: 48, height: 48, contain: true },
            { file: 'app/src/main/res/mipmap-mdpi/ic_launcher_round.png', width: 48, height: 48, contain: true },
            { file: 'app/src/main/res/mipmap-hdpi/ic_launcher.png', width: 72, height: 72, contain: true },
            { file: 'app/src/main/res/mipmap-hdpi/ic_launcher_round.png', width: 72, height: 72, contain: true },
            { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher.png', width: 96, height: 96, contain: true },
            { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher_round.png', width: 96, height: 96, contain: true },
            { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png', width: 144, height: 144, contain: true },
            { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png', width: 144, height: 144, contain: true },
            { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', width: 192, height: 192, contain: true },
            { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png', width: 192, height: 192, contain: true }
        ];

        for (const target of targets) {
            const fullPath = path.join(process.cwd(), target.file);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Generate image using Sharp
            const transformer = sharp(imageBuffer);
            if (target.contain) {
                transformer.resize(target.width, target.height, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                });
            } else {
                transformer.resize(target.width, target.height);
            }

            // Write to project source directory
            await transformer.png({ quality: 100, compressionLevel: 9 }).toFile(fullPath);

            // If it is a web asset under public/, copy it directly to dist/ to make it live instantly
            if (target.file.startsWith('public/')) {
                const distPath = path.join(process.cwd(), 'dist', target.file.replace('public/', ''));
                const distDir = path.dirname(distPath);
                if (!fs.existsSync(distDir)) {
                    fs.mkdirSync(distDir, { recursive: true });
                }
                fs.copyFileSync(fullPath, distPath);
            }
        }

        logger.info('[LogoGenerator] Successfully regenerated all favicons, web icons, and Android mipmaps!');
        return { success: true };
    } catch (err) {
        logger.error('[LogoGenerator] Failed to regenerate logo sizes:', err.message);
        throw err;
    }
}

module.exports = {
    regenerateLogo
};
