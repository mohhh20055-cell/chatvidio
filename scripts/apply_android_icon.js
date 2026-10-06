const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function applyAndroidAppIcon() {
    // Locate the newly generated image in src/assets/images/
    const assetsDir = path.join(process.cwd(), 'src/assets/images');
    if (!fs.existsSync(assetsDir)) {
        console.error('Assets directory does not exist:', assetsDir);
        process.exit(1);
    }

    const files = fs.readdirSync(assetsDir);
    const iconFile = files.find(f => f.startsWith('zoomdz_app_icon'));
    if (!iconFile) {
        console.error('No generated zoomdz_app_icon file found in', assetsDir);
        process.exit(1);
    }

    const imagePath = path.join(assetsDir, iconFile);
    console.log('Using generated icon:', imagePath);

    const imageBuffer = fs.readFileSync(imagePath);

    // List of ONLY Android app icon target files
    const androidTargets = [
        // Android drawables & adaptive icon foregrounds
        { file: 'app/src/main/res/drawable/app_logo.png', width: 512, height: 512 },
        { file: 'app/src/main/res/drawable/ic_logo_img.png', width: 512, height: 512 },
        { file: 'app/src/main/res/drawable/ic_launcher_foreground.png', width: 512, height: 512 },
        { file: 'app/src/main/res/drawable-nodpi/app_logo.png', width: 512, height: 512 },
        { file: 'app/src/main/res/drawable-nodpi/ic_launcher_foreground.png', width: 512, height: 512 },

        // Android mipmap launcher icons
        { file: 'app/src/main/res/mipmap-mdpi/ic_launcher.png', width: 48, height: 48 },
        { file: 'app/src/main/res/mipmap-mdpi/ic_launcher_round.png', width: 48, height: 48, round: true },
        { file: 'app/src/main/res/mipmap-hdpi/ic_launcher.png', width: 72, height: 72 },
        { file: 'app/src/main/res/mipmap-hdpi/ic_launcher_round.png', width: 72, height: 72, round: true },
        { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher.png', width: 96, height: 96 },
        { file: 'app/src/main/res/mipmap-xhdpi/ic_launcher_round.png', width: 96, height: 96, round: true },
        { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png', width: 144, height: 144 },
        { file: 'app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png', width: 144, height: 144, round: true },
        { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', width: 192, height: 192 },
        { file: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png', width: 192, height: 192, round: true }
    ];

    for (const target of androidTargets) {
        const fullPath = path.join(process.cwd(), target.file);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        let pipeline = sharp(imageBuffer).resize(target.width, target.height, { fit: 'cover' });

        if (target.round) {
            // Cut a circle mask for round icons
            const circleSvg = Buffer.from(
                `<svg width="${target.width}" height="${target.height}"><circle cx="${target.width/2}" cy="${target.height/2}" r="${target.width/2}" fill="#fff"/></svg>`
            );
            pipeline = pipeline.composite([{ input: circleSvg, blend: 'dest-in' }]);
        }

        await pipeline.png({ quality: 100 }).toFile(fullPath);
        console.log(`Updated Android asset: ${target.file}`);
    }

    console.log('Successfully updated all Android app launcher icons and drawables!');
}

applyAndroidAppIcon().catch(err => {
    console.error('Error applying Android app icon:', err);
    process.exit(1);
});
