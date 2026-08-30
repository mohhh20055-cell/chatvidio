const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

const oldRoute = `app.get(['/package/:id', '/packages/:id', '/package-details.html'], (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=600');
    res.sendFile(path.join(__dirname, 'public', 'package-details.html'));
});`;

const newRoute = `app.get(['/package/:id', '/packages/:id', '/package-details.html'], (req, res) => {
    const pkgId = req.params.id || req.query.id;
    if (pkgId) {
        return res.redirect(301, '/student-dashboard.html?package=' + pkgId);
    }
    // Fallback if no ID is provided
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=600');
    res.sendFile(path.join(__dirname, 'public', 'package-details.html'));
});`;

if (content.includes("app.get(['/package/:id', '/packages/:id', '/package-details.html']")) {
    content = content.replace(oldRoute, newRoute);
    fs.writeFileSync('server.js', content);
    console.log("Replaced successfully.");
} else {
    console.log("Could not find the route.");
}
