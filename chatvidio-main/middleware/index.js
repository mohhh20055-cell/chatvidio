// middleware/index.js
const auth = require('./auth');

// إعادة تصدير كل الدوال
module.exports = {
    authenticate: auth.authenticate,
    authorize: auth.authorize,
    checkBanned: auth.checkBanned
};
