const express = require('express');
const multer = require('multer');
const app = express();
app.use(express.json());
const upload = multer({ dest: 'uploads/' });
app.post('/test', upload.single('thumbnail'), (req, res) => {
    res.json(req.body);
});
const request = require('http').request;
app.listen(3001, () => {
    const req = request('http://127.0.0.1:3001/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            console.log("Body:", data);
            process.exit(0);
        });
    });
    req.write(JSON.stringify({ plan_type: "1_month" }));
    req.end();
});
